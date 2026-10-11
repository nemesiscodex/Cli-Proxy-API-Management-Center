import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { parse as parseYaml } from 'yaml';
import i18n from '@/i18n';
import { ApiKeysField } from '../src/features/config/components/fields/sharedFields';
import { DEFAULT_VISUAL_VALUES } from '../src/types/visualConfig';
import {
  dropKeyCredentials,
  parseKeyCredentials,
  setKeyCredentials,
  splitCredentialPatterns,
} from '../src/features/config/keyCredentials';
import { normalizeAuthFilesResponse } from '../src/services/api/authFiles';
import type { AuthFilesResponse } from '../src/types/authFile';
import { runVisualConfig } from './helpers/visualConfig';

const yaml = `# root comment
access:
  api-keys:
    - main-key
    - limited-key
  key-credentials:
    # limited comment
    - key: limited-key
      credentials:
        - claude-a@example.com.json
        - codex-*.json
    - key: orphan-key
      credentials: []
server:
  port: 8317
`;

describe('access.key-credentials visual config', () => {
  test('parses tolerantly: skips keyless entries, trims and dedupes credentials', () => {
    expect(
      parseKeyCredentials([
        { key: ' a ', credentials: [' x.json ', 'x.json', '', 7, 'codex-*.json'] },
        { credentials: ['ignored.json'] },
        { key: '' },
        'not-a-record',
        { key: 'b' },
      ])
    ).toEqual([
      { key: 'a', credentials: ['x.json', 'codex-*.json'] },
      { key: 'b', credentials: [] },
    ]);
    expect(parseKeyCredentials(undefined)).toEqual([]);
  });

  test('loads entries and round-trips unchanged when nothing is edited', () => {
    const config = runVisualConfig(yaml);
    expect(config.visualValues.keyCredentials).toEqual([
      { key: 'limited-key', credentials: ['claude-a@example.com.json', 'codex-*.json'] },
      { key: 'orphan-key', credentials: [] },
    ]);
    expect(config.visualDirty).toBe(false);
    expect(config.applyVisualChangesToYaml(yaml)).toBe(yaml);
  });

  test('writes edits, keeping entries for keys not in api-keys and unrelated YAML', () => {
    const original = runVisualConfig(yaml).visualValues.keyCredentials;
    const config = runVisualConfig(yaml, [
      { keyCredentials: setKeyCredentials(original, 'main-key', ['gemini-*.json']) },
    ]);
    expect([...config.visualDirtyFields]).toEqual(['keyCredentials']);
    const output = config.applyVisualChangesToYaml(yaml);
    expect(parseYaml(output)).toEqual({
      access: {
        'api-keys': ['main-key', 'limited-key'],
        'key-credentials': [
          { key: 'limited-key', credentials: ['claude-a@example.com.json', 'codex-*.json'] },
          { key: 'orphan-key', credentials: [] },
          { key: 'main-key', credentials: ['gemini-*.json'] },
        ],
      },
      server: { port: 8317 },
    });
    expect(output).toContain('# root comment');
  });

  test('an empty list removes access.key-credentials', () => {
    const config = runVisualConfig(yaml, [{ keyCredentials: [] }]);
    expect(parseYaml(config.applyVisualChangesToYaml(yaml))).toEqual({
      access: { 'api-keys': ['main-key', 'limited-key'] },
      server: { port: 8317 },
    });
  });

  test('renaming a key moves its entry in place', () => {
    const original = runVisualConfig(yaml).visualValues.keyCredentials;
    const renamed = setKeyCredentials(
      original,
      'renamed-key',
      ['claude-a@example.com.json', 'codex-*.json'],
      'limited-key'
    );
    const config = runVisualConfig(yaml, [
      { apiKeysText: 'main-key\nrenamed-key', keyCredentials: renamed },
    ]);
    expect(parseYaml(config.applyVisualChangesToYaml(yaml)).access).toEqual({
      'api-keys': ['main-key', 'renamed-key'],
      'key-credentials': [
        { key: 'renamed-key', credentials: ['claude-a@example.com.json', 'codex-*.json'] },
        { key: 'orphan-key', credentials: [] },
      ],
    });
  });

  test('deleting a key drops its entry; switching to all accounts removes it too', () => {
    const original = runVisualConfig(yaml).visualValues.keyCredentials;
    const expected = [{ key: 'orphan-key', credentials: [] }];
    expect(dropKeyCredentials(original, 'limited-key')).toEqual(expected);
    expect(setKeyCredentials(original, 'limited-key', null)).toEqual(expected);

    const config = runVisualConfig(yaml, [
      { apiKeysText: 'main-key', keyCredentials: dropKeyCredentials(original, 'limited-key') },
    ]);
    expect(parseYaml(config.applyVisualChangesToYaml(yaml)).access).toEqual({
      'api-keys': ['main-key'],
      'key-credentials': expected,
    });
  });

  test('restoring the original entries clears the dirty flag', () => {
    const original = runVisualConfig(yaml).visualValues.keyCredentials;
    const config = runVisualConfig(yaml, [
      { keyCredentials: dropKeyCredentials(original, 'limited-key') },
      { keyCredentials: original.map((entry) => ({ ...entry })) },
    ]);
    expect(config.visualDirty).toBe(false);
  });

  test('splits patterns into listed account IDs and extra patterns', () => {
    expect(
      splitCredentialPatterns(
        ['claude-a@example.com.json', 'codex-*.json', 'claude:apikey:abc'],
        new Set(['claude-a@example.com.json', 'codex-b.json'])
      )
    ).toEqual({
      selected: ['claude-a@example.com.json'],
      extra: ['codex-*.json', 'claude:apikey:abc'],
    });
  });

  test('key rows summarize which accounts each key may use', () => {
    const values = {
      ...DEFAULT_VISUAL_VALUES,
      apiKeysText: 'main-key\nlimited-key\nsingle-key',
      keyCredentials: [
        { key: 'limited-key', credentials: ['a.json', 'codex-*.json'] },
        { key: 'single-key', credentials: ['a.json'] },
      ],
    };
    const markup = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n: i18n.cloneInstance({ lng: 'en' }) },
        createElement(ApiKeysField, { values, disabled: false, onChange: () => {} })
      )
    );
    expect(markup.match(/class="pill">([^<]+)</g)?.filter((pill) => !pill.includes('#'))).toEqual([
      'class="pill">All accounts<',
      'class="pill">Limited: 2 accounts<',
      'class="pill">Limited: 1 account<',
    ]);
  });

  test('credential listing keeps the account id', () => {
    const result = normalizeAuthFilesResponse({
      files: [{ id: 'claude-a@example.com.json', name: 'claude-a@example.com.json' }],
    } as unknown as AuthFilesResponse);
    expect(result.files[0]?.id).toBe('claude-a@example.com.json');
  });
});
