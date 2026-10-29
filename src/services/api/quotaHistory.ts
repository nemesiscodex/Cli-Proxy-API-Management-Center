import { apiClient } from './client';

export const quotaHistoryApi = {
  /** Raw body; `parseServerQuotaHistory` validates it. */
  get: () => apiClient.get<unknown>('/credentials/quota-history'),
};
