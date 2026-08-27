'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  fetchAuditLog,
  fetchReconciliation,
  fetchReconciliationHistory,
  type AuditLogQuery,
} from '@/lib/adminAuditClient';
import type {
  AdminAuditEntry,
  ReconciliationResult,
  ReconciliationRun,
} from '@/lib/adminAudit';

/**
 * Reconciliation is re-run on an interval while the admin has the audit log
 * open, satisfying "periodically (or on-demand)" without needing separate
 * cron infrastructure in this deployment (see docs/admin-audit-log.md for
 * how to additionally wire a scheduled trigger, e.g. Vercel Cron, for
 * reconciliation to also run while no admin is looking).
 */
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

export interface UseAdminAuditLogResult {
  entries: AdminAuditEntry[];
  loading: boolean;
  error: boolean;
  filter: AuditLogQuery;
  setFilter: (filter: AuditLogQuery) => void;
  reconciliation: ReconciliationResult | null;
  reconciling: boolean;
  runReconciliation: () => void;
  refetch: () => void;
  reconciliationHistory: ReconciliationRun[];
  reconciliationHistoryLoading: boolean;
}

export function useAdminAuditLog(): UseAdminAuditLogResult {
  const [entries, setEntries] = useState<AdminAuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<AuditLogQuery>({ limit: 100 });

  const [reconciliation, setReconciliation] =
    useState<ReconciliationResult | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [reconciliationHistory, setReconciliationHistory] = useState<
    ReconciliationRun[]
  >([]);
  const [reconciliationHistoryLoading, setReconciliationHistoryLoading] =
    useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(false);
    fetchAuditLog(filter)
      .then((result) => setEntries(result.entries))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  const loadReconciliationHistory = useCallback(() => {
    setReconciliationHistoryLoading(true);
    fetchReconciliationHistory()
      .then(setReconciliationHistory)
      .catch(() => {
        // Same rationale as runReconciliation's catch below — leave
        // whatever history was last successfully loaded in place.
      })
      .finally(() => setReconciliationHistoryLoading(false));
  }, []);

  const runReconciliation = useCallback(() => {
    setReconciling(true);
    fetchReconciliation()
      .then((result) => {
        setReconciliation(result);
        // Each run is persisted server-side as it happens (issue #1188) —
        // refresh the history list so it shows up without a manual reload.
        loadReconciliationHistory();
      })
      .catch(() => {
        // A failed reconciliation check is itself worth surfacing distinctly
        // from "no mismatches" — leave `reconciliation` as-is (stale, not
        // wiped) rather than pretending everything is fine.
      })
      .finally(() => setReconciling(false));
  }, [loadReconciliationHistory]);

  useEffect(() => {
    runReconciliation();
    const interval = setInterval(runReconciliation, RECONCILE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [runReconciliation]);

  return {
    entries,
    loading,
    error,
    filter,
    setFilter,
    reconciliation,
    reconciling,
    runReconciliation,
    refetch: load,
    reconciliationHistory,
    reconciliationHistoryLoading,
  };
}
