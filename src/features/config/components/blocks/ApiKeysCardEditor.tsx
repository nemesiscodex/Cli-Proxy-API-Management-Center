import { memo, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useAuthStore, useNotificationStore } from '@/stores';
import { apiKeyNameFingerprint, readApiKeyNames, saveApiKeyName } from '../../apiKeyNames';
import {
  dropKeyCredentials,
  findKeyCredentials,
  normalizeCredentialPatterns,
  setKeyCredentials,
  splitCredentialPatterns,
} from '../../keyCredentials';
import { authFilesApi } from '@/services/api/authFiles';
import type { AuthFileItem } from '@/types/authFile';
import { copyToClipboard } from '@/utils/clipboard';
import { makeClientId, type KeyCredentialEntry } from '@/types/visualConfig';
import { generateSecureApiKey } from '@/utils/apiKey';
import { maskApiKey } from '@/utils/format';
import { isValidApiKeyCharset } from '@/utils/validation';
import {
  ApiKeyAccessFields,
  type ApiKeyAccessMode,
  type ApiKeyAccountOption,
  type ApiKeyAccountsState,
} from './ApiKeyAccessFields';
import { ApiKeyStrengthMeter } from './ApiKeyStrengthMeter';
import styles from './Blocks.module.scss';

export type ApiKeysPatch = { apiKeysText: string; keyCredentials: KeyCredentialEntry[] };

interface ApiKeysCardEditorProps {
  apiKeysText: string;
  keyCredentials: KeyCredentialEntry[];
  disabled?: boolean;
  onChange: (patch: ApiKeysPatch) => void;
}

function toAccountOption(file: AuthFileItem): ApiKeyAccountOption {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  return {
    id: text(file.id) || file.name,
    title: text(file.label) || text(file.email) || file.name,
    provider: text(file.provider) || text(file.type),
  };
}

const splitLines = (text: string) => normalizeCredentialPatterns(text.split('\n'));

const sameSet = (left: string[], right: string[]) =>
  left.length === right.length && left.every((item) => right.includes(item));

export const ApiKeysCardEditor = memo(function ApiKeysCardEditor(props: ApiKeysCardEditorProps) {
  const apiBase = useAuthStore((state) => state.apiBase);
  return <ScopedApiKeysCardEditor key={apiBase} {...props} apiBase={apiBase} />;
});

function ScopedApiKeysCardEditor({
  apiKeysText,
  keyCredentials,
  disabled,
  onChange,
  apiBase,
}: ApiKeysCardEditorProps & { apiBase: string }) {
  const [names, setNames] = useState(() => readApiKeyNames(apiBase));
  const [nameValue, setNameValue] = useState('');
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const apiKeys = useMemo(
    () =>
      apiKeysText
        .split('\n')
        .map((key) => key.trim())
        .filter(Boolean),
    [apiKeysText]
  );
  const nameFingerprints = useMemo(
    () => apiKeys.map((key) => apiKeyNameFingerprint(apiBase, key)),
    [apiBase, apiKeys]
  );
  const [apiKeyIds, setApiKeyIds] = useState(() => apiKeys.map(() => makeClientId()));
  const renderApiKeyIds = useMemo(() => {
    if (apiKeyIds.length === apiKeys.length) return apiKeyIds;
    if (apiKeyIds.length > apiKeys.length) return apiKeyIds.slice(0, apiKeys.length);
    return [
      ...apiKeyIds,
      ...Array.from({ length: apiKeys.length - apiKeyIds.length }, () => makeClientId()),
    ];
  }, [apiKeyIds, apiKeys.length]);

  const apiKeyInputId = useId();
  const nameInputId = useId();
  const nameHintId = `${nameInputId}-hint`;
  const apiKeyHintId = `${apiKeyInputId}-hint`;
  const apiKeyErrorId = `${apiKeyInputId}-error`;
  const [modalOpen, setModalOpen] = useState(false);
  const [editingApiKeyId, setEditingApiKeyId] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [formError, setFormError] = useState('');
  const [accessMode, setAccessMode] = useState<ApiKeyAccessMode>('all');
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [extraPatternsText, setExtraPatternsText] = useState('');
  const [accessError, setAccessError] = useState('');
  const [accountsState, setAccountsState] = useState<ApiKeyAccountsState>({ status: 'loading' });
  const accountsRequestRef = useRef(0);

  // Patterns start in the free-text box; once the account list arrives, exact IDs move to checkboxes.
  // If the list fails to load, every pattern stays editable as text.
  const openAccess = (patterns: string[] | null) => {
    setAccessMode(patterns ? 'limited' : 'all');
    setSelectedAccountIds([]);
    setExtraPatternsText((patterns ?? []).join('\n'));
    setAccessError('');
    setAccountsState({ status: 'loading' });
    const request = ++accountsRequestRef.current;
    authFilesApi
      .list()
      .then((response) => {
        if (request !== accountsRequestRef.current) return;
        const accounts = response.files.map(toAccountOption);
        const { selected } = splitCredentialPatterns(
          patterns ?? [],
          new Set(accounts.map((account) => account.id))
        );
        const moved = new Set(selected);
        setSelectedAccountIds((current) => normalizeCredentialPatterns([...current, ...selected]));
        setExtraPatternsText((current) =>
          splitLines(current)
            .filter((line) => !moved.has(line))
            .join('\n')
        );
        setAccountsState({ status: 'ready', accounts });
      })
      .catch(() => {
        if (request !== accountsRequestRef.current) return;
        setAccountsState({ status: 'error' });
      });
  };

  const openAddModal = () => {
    setNameValue('');
    setEditingApiKeyId(null);
    setInputValue('');
    setFormError('');
    openAccess(null);
    setModalOpen(true);
  };

  const openEditModal = (apiKeyId: string) => {
    const editingIndex = renderApiKeyIds.findIndex((id) => id === apiKeyId);
    const latestNames = readApiKeyNames(apiBase);
    setNames(latestNames);
    setNameValue(latestNames[nameFingerprints[editingIndex]] ?? '');
    setEditingApiKeyId(apiKeyId);
    setInputValue(apiKeys[editingIndex] ?? '');
    setFormError('');
    openAccess(findKeyCredentials(keyCredentials, apiKeys[editingIndex] ?? ''));
    setModalOpen(true);
  };

  const closeModal = () => {
    accountsRequestRef.current += 1;
    setModalOpen(false);
    setInputValue('');
    setEditingApiKeyId(null);
    setFormError('');
    setAccessError('');
  };

  const handleDelete = (apiKeyId: string) => {
    const index = renderApiKeyIds.findIndex((id) => id === apiKeyId);
    if (index < 0) return;
    const deletedKey = apiKeys[index];
    const nextKeys = apiKeys.filter((_, i) => i !== index);
    setApiKeyIds(renderApiKeyIds.filter((id) => id !== apiKeyId));
    onChange({
      apiKeysText: nextKeys.join('\n'),
      // A duplicate of the deleted key still needs its restriction.
      keyCredentials: nextKeys.includes(deletedKey)
        ? keyCredentials
        : dropKeyCredentials(keyCredentials, deletedKey),
    });
  };

  const toggleAccount = (id: string) => {
    setAccessError('');
    setSelectedAccountIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
  };

  const handleSave = () => {
    const trimmed = inputValue.trim();
    if (!trimmed) {
      setFormError(t('config_management.visual.api_keys.error_empty'));
      return;
    }
    if (!isValidApiKeyCharset(trimmed)) {
      setFormError(t('config_management.visual.api_keys.error_invalid'));
      return;
    }

    let credentials: string[] | null = null;
    if (accessMode === 'limited') {
      credentials = normalizeCredentialPatterns([
        ...selectedAccountIds,
        ...splitLines(extraPatternsText),
      ]);
      // An empty list would lock the key out of every account; never write one from here.
      if (credentials.length === 0) {
        setAccessError(t('config_management.visual.api_keys.access_error_empty'));
        return;
      }
    }

    const editingIndex = editingApiKeyId
      ? renderApiKeyIds.findIndex((id) => id === editingApiKeyId)
      : -1;
    const nextKeys =
      editingApiKeyId === null
        ? [...apiKeys, trimmed]
        : apiKeys.map((key, idx) => (idx === editingIndex ? trimmed : key));
    const previousKey = editingIndex >= 0 ? apiKeys[editingIndex] : undefined;
    const existing = findKeyCredentials(keyCredentials, previousKey ?? trimmed);
    // Keep the stored order when only the checkbox/text split changed the order.
    if (credentials && existing && sameSet(credentials, existing)) credentials = existing;
    const nextCredentials = setKeyCredentials(
      keyCredentials,
      trimmed,
      credentials,
      previousKey !== undefined && !nextKeys.includes(previousKey) ? previousKey : undefined
    );
    if (!saveApiKeyName(apiBase, trimmed, nameValue)) {
      setFormError(t('config_management.visual.api_keys.name_save_error'));
      return;
    }
    setNames(readApiKeyNames(apiBase));
    // Retain old fingerprints: configuration edits can still be discarded or fail to save.
    if (editingApiKeyId === null) {
      setApiKeyIds([...renderApiKeyIds, makeClientId()]);
    }
    onChange({ apiKeysText: nextKeys.join('\n'), keyCredentials: nextCredentials });
    closeModal();
  };

  const renderAccessSummary = (key: string) => {
    const patterns = findKeyCredentials(keyCredentials, key);
    return patterns
      ? t('config_management.visual.api_keys.access_summary_limited', { count: patterns.length })
      : t('config_management.visual.api_keys.access_summary_all');
  };

  const handleCopy = async (apiKey: string) => {
    const copied = await copyToClipboard(apiKey);
    showNotification(
      t(copied ? 'notification.link_copied' : 'notification.copy_failed'),
      copied ? 'success' : 'error'
    );
  };

  const handleGenerate = () => {
    setInputValue(generateSecureApiKey());
    setFormError('');
  };

  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <div className={styles.blockHeaderRow}>
        <label style={{ margin: 0 }}>{t('config_management.visual.api_keys.label')}</label>
        <Button size="sm" onClick={openAddModal} disabled={disabled}>
          {t('config_management.visual.api_keys.add')}
        </Button>
      </div>

      {apiKeys.length === 0 ? (
        <div className={styles.emptyState}>{t('config_management.visual.api_keys.empty')}</div>
      ) : (
        <div className="item-list" style={{ marginTop: 4 }}>
          {apiKeys.map((key, index) => (
            <div key={renderApiKeyIds[index] ?? `${key}-${index}`} className="item-row">
              <div className="item-meta">
                <div className="pill">#{index + 1}</div>
                <div className="item-title">
                  {names[nameFingerprints[index]] ??
                    t('config_management.visual.api_keys.input_label')}
                </div>
                <div className="item-subtitle">{maskApiKey(String(key || ''))}</div>
                <div>
                  <span className="pill">{renderAccessSummary(key)}</span>
                </div>
              </div>
              <div className="item-actions">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleCopy(key)}
                  disabled={disabled}
                >
                  {t('common.copy')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => openEditModal(renderApiKeyIds[index] ?? '')}
                  disabled={disabled}
                >
                  {t('config_management.visual.common.edit')}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => handleDelete(renderApiKeyIds[index] ?? '')}
                  disabled={disabled}
                >
                  {t('config_management.visual.common.delete')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="hint">{t('config_management.visual.api_keys.hint')}</div>

      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={
          editingApiKeyId !== null
            ? t('config_management.visual.api_keys.edit_title')
            : t('config_management.visual.api_keys.add_title')
        }
        footer={
          <>
            <Button variant="secondary" onClick={closeModal} disabled={disabled}>
              {t('config_management.visual.common.cancel')}
            </Button>
            <Button onClick={handleSave} disabled={disabled}>
              {editingApiKeyId !== null
                ? t('config_management.visual.common.update')
                : t('config_management.visual.common.add')}
            </Button>
          </>
        }
      >
        <div className="form-group">
          <label htmlFor={nameInputId}>{t('config_management.visual.api_keys.name_label')}</label>
          <input
            id={nameInputId}
            className="input"
            value={nameValue}
            onChange={(event) => setNameValue(event.target.value)}
            placeholder={t('config_management.visual.api_keys.name_placeholder')}
            aria-describedby={nameHintId}
            disabled={disabled}
          />
          <div id={nameHintId} className="hint">
            {t('config_management.visual.api_keys.name_hint')}
          </div>
        </div>
        <div className="form-group">
          <label htmlFor={apiKeyInputId}>
            {t('config_management.visual.api_keys.input_label')}
          </label>
          <div className={styles.apiKeyModalInputRow}>
            <input
              id={apiKeyInputId}
              className="input"
              placeholder={t('config_management.visual.api_keys.input_placeholder')}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              disabled={disabled}
              aria-describedby={formError ? `${apiKeyErrorId} ${apiKeyHintId}` : apiKeyHintId}
              aria-invalid={Boolean(formError)}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleGenerate}
              disabled={disabled}
            >
              {t('config_management.visual.api_keys.generate')}
            </Button>
          </div>
          <ApiKeyStrengthMeter value={inputValue} />
          <div id={apiKeyHintId} className="hint">
            {t('config_management.visual.api_keys.input_hint')}
          </div>
          {formError && (
            <div id={apiKeyErrorId} className="error-box">
              {formError}
            </div>
          )}
        </div>
        <ApiKeyAccessFields
          mode={accessMode}
          selectedIds={selectedAccountIds}
          extraText={extraPatternsText}
          accountsState={accountsState}
          error={accessError}
          disabled={disabled}
          onModeChange={(mode) => {
            setAccessMode(mode);
            setAccessError('');
          }}
          onToggleAccount={toggleAccount}
          onExtraTextChange={(text) => {
            setExtraPatternsText(text);
            setAccessError('');
          }}
        />
      </Modal>
    </div>
  );
}
