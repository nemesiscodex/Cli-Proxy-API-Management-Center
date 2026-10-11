import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './Blocks.module.scss';

export type ApiKeyAccessMode = 'all' | 'limited';

export type ApiKeyAccountOption = {
  /** Login file name relative to the auth dir; what key-credentials patterns match against. */
  id: string;
  title: string;
  provider: string;
};

export type ApiKeyAccountsState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; accounts: ApiKeyAccountOption[] };

interface ApiKeyAccessFieldsProps {
  mode: ApiKeyAccessMode;
  selectedIds: string[];
  extraText: string;
  accountsState: ApiKeyAccountsState;
  error: string;
  disabled?: boolean;
  onModeChange: (mode: ApiKeyAccessMode) => void;
  onToggleAccount: (id: string) => void;
  onExtraTextChange: (text: string) => void;
}

export function ApiKeyAccessFields({
  mode,
  selectedIds,
  extraText,
  accountsState,
  error,
  disabled,
  onModeChange,
  onToggleAccount,
  onExtraTextChange,
}: ApiKeyAccessFieldsProps) {
  const { t } = useTranslation();
  const radioName = useId();
  const extraInputId = useId();
  const errorId = `${extraInputId}-error`;
  const selected = new Set(selectedIds);

  return (
    <div className="form-group">
      <label>{t('config_management.visual.api_keys.access_label')}</label>
      <div className={styles.apiKeyAccessRow} role="radiogroup">
        {(['all', 'limited'] as const).map((option) => (
          <label key={option} className={styles.storeAuthCheckbox}>
            <input
              type="radio"
              name={radioName}
              checked={mode === option}
              disabled={disabled}
              onChange={() => onModeChange(option)}
            />
            <span>{t(`config_management.visual.api_keys.access_${option}`)}</span>
          </label>
        ))}
      </div>

      {mode === 'limited' && (
        <>
          {accountsState.status === 'loading' && (
            <div className="hint">{t('config_management.visual.api_keys.accounts_loading')}</div>
          )}
          {accountsState.status === 'error' && (
            <div className="error-box">
              {t('config_management.visual.api_keys.accounts_load_error')}
            </div>
          )}
          {accountsState.status === 'ready' &&
            (accountsState.accounts.length === 0 ? (
              <div className="hint">{t('config_management.visual.api_keys.accounts_empty')}</div>
            ) : (
              <div className={styles.apiKeyAccountList}>
                {accountsState.accounts.map((account) => (
                  <label key={account.id} className={styles.apiKeyAccount}>
                    <input
                      type="checkbox"
                      checked={selected.has(account.id)}
                      disabled={disabled}
                      onChange={() => onToggleAccount(account.id)}
                    />
                    <span className={styles.apiKeyAccountText}>
                      <span>
                        {account.title}
                        {account.provider ? ` · ${account.provider}` : ''}
                      </span>
                      <span className={styles.apiKeyAccountId}>{account.id}</span>
                    </span>
                  </label>
                ))}
              </div>
            ))}

          <label htmlFor={extraInputId} style={{ marginTop: 10 }}>
            {t('config_management.visual.api_keys.extra_patterns_label')}
          </label>
          <textarea
            id={extraInputId}
            className="input"
            rows={3}
            value={extraText}
            onChange={(event) => onExtraTextChange(event.target.value)}
            placeholder="codex-*.json"
            disabled={disabled}
            aria-describedby={error ? errorId : undefined}
            aria-invalid={Boolean(error)}
          />
          <div className="hint">{t('config_management.visual.api_keys.extra_patterns_hint')}</div>
          {error && (
            <div id={errorId} className="error-box">
              {error}
            </div>
          )}
        </>
      )}
    </div>
  );
}
