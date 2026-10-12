'use client';

/**
 * 知识库管理弹窗。
 *
 * 后端契约来自 `@openteach/plugin-kb`（`/api/kb/*`）：`POST /knowledge-bases` 新建、
 * `DELETE /knowledge-bases/:kbName` 整库删除、`POST /index` 入库。**目录以服务端为
 * 唯一真相**：本弹窗每次变更都重新拉取库列表，并通过 `onCatalogChange` 通知调用方
 * 刷新它自己的下拉 —— 否则弹窗里新建的库在表单里看不见，只能刷新页面。
 *
 * 服务不可用时（后端未装配 kb 插件、或 `/api/kb` 未被代理到 OpenTeach）只显示
 * 提示并禁用所有写操作，不抛错、不影响课堂生成。
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, BookOpen, FileText, Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import {
  KbApiError,
  createKnowledgeBase,
  deleteKbDocument,
  deleteKnowledgeBase,
  indexKbDocument,
  listKbDocuments,
  probeKnowledgeBase,
} from '@/lib/kb/client';
import type { KbDocument } from '@/lib/kb/types';
import { cn } from '@/lib/utils';

const log = createLogger('KnowledgeManager');

/** 与后端 `KB_NAME_PATTERN` 一致：挡路径穿越，也避免建出无法访问的库。 */
const KB_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** 待确认的删除目标：文档与整库走同一个确认弹窗。 */
type PendingDelete =
  | { kind: 'document'; document: KbDocument }
  | { kind: 'knowledgeBase'; kbName: string };

interface KnowledgeManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前用于生成的知识库名；弹窗内切换会回调给调用方。 */
  activeKbName?: string;
  onActiveKbNameChange?: (kbName: string) => void;
  /**
   * 库列表（目录）发生变化时回调，参数为最新列表。
   * 调用方据此刷新自己的知识库下拉；不回调就会留下陈旧列表。
   */
  onCatalogChange?: (kbNames: string[]) => void;
}

export function KnowledgeManagerDialog({
  open,
  onOpenChange,
  activeKbName,
  onActiveKbNameChange,
  onCatalogChange,
}: KnowledgeManagerDialogProps) {
  const { t } = useI18n();

  const [available, setAvailable] = useState(true);
  const [probing, setProbing] = useState(false);
  const [knowledgeBases, setKnowledgeBases] = useState<string[]>([]);
  const [selectedKb, setSelectedKb] = useState('');
  const [newKbName, setNewKbName] = useState('');

  // 文档列表连同它所属的库名一起记录：切换库时旧结果不会短暂串到新库下。
  const [documents, setDocuments] = useState<{ kbName: string; items: KbDocument[] }>({
    kbName: '',
    items: [],
  });
  const [loadingDocuments, setLoadingDocuments] = useState(false);

  const [draft, setDraft] = useState({ title: '', text: '', source: '' });
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

  const reloadDocuments = useCallback(async (kbName: string) => {
    if (!kbName) return;
    setLoadingDocuments(true);
    try {
      const items = await listKbDocuments(kbName);
      setDocuments({ kbName, items });
    } catch (error) {
      log.warn(`读取知识库「${kbName}」文档失败:`, error);
      setDocuments({ kbName, items: [] });
    } finally {
      setLoadingDocuments(false);
    }
  }, []);

  const reloadKnowledgeBases = useCallback(async () => {
    const status = await probeKnowledgeBase();
    setAvailable(status.available);
    setKnowledgeBases(status.knowledgeBases);
    onCatalogChange?.(status.knowledgeBases);
    return status;
  }, [onCatalogChange]);

  /**
   * 在候选名里挑一个**确实存在**的：优先保留原选择，其次调用方传入的，最后取第一个。
   * 用于把「库已被删掉 / 名字来自陈旧的 localStorage」这类悬空选择就地纠正，
   * 否则界面会显示一个查不到的库名，生成时又静默检索空库。
   */
  const pickExistingKb = useCallback(
    (kbNames: string[], preferred: string): string => {
      if (preferred && kbNames.includes(preferred)) return preferred;
      if (activeKbName && kbNames.includes(activeKbName)) return activeKbName;
      return kbNames[0] ?? '';
    },
    [activeKbName],
  );

  // 打开时探针 + 拉库列表。所有 setState 都在 await 之后，避免在 effect 里同步置态。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      setProbing(true);
      const status = await reloadKnowledgeBases();
      if (cancelled) return;
      setSelectedKb((prev) => pickExistingKb(status.knowledgeBases, prev));
      setProbing(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, activeKbName, reloadKnowledgeBases, pickExistingKb]);

  /**
   * 把弹窗内的选择同步给调用方 —— 只在打开时同步：关闭时调用方可能自行改了选择，
   * 此时再由弹窗反向覆盖会互相打架。选择被 `pickExistingKb` 纠正过也走这条路径。
   */
  useEffect(() => {
    if (!open) return;
    if (selectedKb !== activeKbName) onActiveKbNameChange?.(selectedKb);
  }, [open, selectedKb, activeKbName, onActiveKbNameChange]);

  useEffect(() => {
    if (!open || !selectedKb) return;
    void reloadDocuments(selectedKb);
  }, [open, selectedKb, reloadDocuments]);

  const selectKb = (kbName: string) => {
    setSelectedKb(kbName);
  };

  /** 新建：真正在后端落盘，成功后以服务端返回的目录为准刷新列表并选中它。 */
  const handleCreateKb = async () => {
    const name = newKbName.trim();
    if (!KB_NAME_PATTERN.test(name)) {
      toast.error(t('knowledge.nameInvalid'));
      return;
    }
    try {
      await createKnowledgeBase(name);
      setNewKbName('');
      await reloadKnowledgeBases();
      setSelectedKb(name);
      toast.success(t('knowledge.manager.created', { kbName: name }));
    } catch (error) {
      // 已存在不是错误：名字打重了，直接切过去即可。
      if (error instanceof KbApiError && error.status === 409) {
        setNewKbName('');
        await reloadKnowledgeBases();
        setSelectedKb(name);
        return;
      }
      log.error('新建知识库失败:', error);
      toast.error(
        t('knowledge.manager.failed', {
          message: error instanceof Error ? error.message : 'Unknown error',
        }),
      );
    }
  };

  const handleIndex = async () => {
    const title = draft.title.trim();
    const text = draft.text.trim();
    if (!selectedKb) {
      toast.error(t('knowledge.manager.needKb'));
      return;
    }
    if (!title || !text) {
      toast.error(t('knowledge.manager.required'));
      return;
    }
    setSaving(true);
    try {
      await indexKbDocument({
        kbName: selectedKb,
        title,
        text,
        ...(draft.source.trim() ? { source: draft.source.trim() } : {}),
      });
      setDraft({ title: '', text: '', source: '' });
      await reloadDocuments(selectedKb);
      await reloadKnowledgeBases();
      toast.success(t('knowledge.manager.indexed', { title }));
    } catch (error) {
      log.error('索引文档失败:', error);
      toast.error(
        t('knowledge.manager.failed', {
          message: error instanceof Error ? error.message : 'Unknown error',
        }),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    try {
      if (target.kind === 'document') {
        if (!selectedKb) return;
        await deleteKbDocument(selectedKb, target.document.id);
        await reloadDocuments(selectedKb);
        toast.success(t('knowledge.manager.deleted'));
        return;
      }

      // 整库删除：删掉的是当前选中项时，要把选择一并落到仍然存在的库上，
      // 否则列表没了、选择还在，编辑区会继续显示一个已消失的库。
      const { kbName } = target;
      await deleteKnowledgeBase(kbName);
      const status = await reloadKnowledgeBases();
      setSelectedKb((prev) =>
        prev === kbName ? pickExistingKb(status.knowledgeBases, '') : prev,
      );
      toast.success(t('knowledge.manager.deletedKb', { kbName }));
    } catch (error) {
      log.error('删除失败:', error);
      toast.error(
        t('knowledge.manager.failed', {
          message: error instanceof Error ? error.message : 'Unknown error',
        }),
      );
    }
  };

  const visibleDocuments = documents.kbName === selectedKb ? documents.items : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('knowledge.managerTitle')}</DialogTitle>
          <DialogDescription>{t('knowledge.managerDescription')}</DialogDescription>
        </DialogHeader>

        {!available && !probing ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-200">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span>{t('knowledge.managerUnavailable')}</span>
          </div>
        ) : (
          <div className="flex min-h-[22rem] gap-3">
            {/* 知识库列表 */}
            <div className="flex w-48 shrink-0 flex-col gap-2">
              <div className="flex items-center justify-between gap-1">
                <p className="text-xs font-medium text-muted-foreground">
                  {t('knowledge.kbList')}
                </p>
                {selectedKb && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={t('knowledge.manager.deleteKb')}
                    title={t('knowledge.manager.deleteKb')}
                    onClick={() => setPendingDelete({ kind: 'knowledgeBase', kbName: selectedKb })}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </div>
              <ScrollArea className="min-h-0 flex-1 rounded-lg border border-border/60">
                <div className="space-y-0.5 p-1">
                  {knowledgeBases.map((kbName) => (
                    <button
                      key={kbName}
                      type="button"
                      onClick={() => selectKb(kbName)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                        selectedKb === kbName
                          ? 'bg-primary/10 font-medium text-primary'
                          : 'hover:bg-muted',
                      )}
                    >
                      <BookOpen className="size-3.5 shrink-0" />
                      <span className="truncate">{kbName}</span>
                    </button>
                  ))}
                  {knowledgeBases.length === 0 && (
                    <p className="px-2 py-3 text-[11px] text-muted-foreground">
                      {t('knowledge.empty')}
                    </p>
                  )}
                </div>
              </ScrollArea>
              <div className="flex items-center gap-1">
                <Input
                  value={newKbName}
                  onChange={(event) => setNewKbName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void handleCreateKb();
                    }
                  }}
                  placeholder={t('knowledge.newKbPlaceholder')}
                  className="h-8 text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-8 shrink-0"
                  aria-label={t('knowledge.createKb')}
                  onClick={() => void handleCreateKb()}
                >
                  <Plus className="size-3.5" />
                </Button>
              </div>
            </div>

            {/* 文档列表 + 入库表单 */}
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-muted-foreground">
                  {t('knowledge.documents')}
                  {selectedKb ? ` · ${selectedKb}` : ''}
                </p>
                {loadingDocuments && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
              </div>

              <ScrollArea className="h-40 rounded-lg border border-border/60">
                <div className="space-y-1 p-1.5">
                  {visibleDocuments.map((document) => (
                    <div
                      key={document.id}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60"
                    >
                      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-xs">{document.title}</span>
                      <span className="shrink-0 truncate text-[11px] text-muted-foreground">
                        {document.source}
                      </span>
                      <Badge variant="secondary" className="shrink-0 text-[10px]">
                        {t('knowledge.chunkCount', { n: document.chunkCount })}
                      </Badge>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                        aria-label={t('knowledge.delete')}
                        onClick={() => setPendingDelete({ kind: 'document', document })}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  ))}
                  {!loadingDocuments && visibleDocuments.length === 0 && (
                    <p className="px-2 py-6 text-center text-[11px] text-muted-foreground">
                      {t('knowledge.noDocuments')}
                    </p>
                  )}
                </div>
              </ScrollArea>

              <div className="space-y-2 rounded-lg border border-border/60 p-3">
                <p className="text-xs font-medium">{t('knowledge.addDocument')}</p>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">
                      {t('knowledge.docTitle')}
                    </Label>
                    <Input
                      value={draft.title}
                      onChange={(event) => setDraft((prev) => ({ ...prev, title: event.target.value }))}
                      placeholder={t('knowledge.docTitlePlaceholder')}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">
                      {t('knowledge.docSource')}
                    </Label>
                    <Input
                      value={draft.source}
                      onChange={(event) =>
                        setDraft((prev) => ({ ...prev, source: event.target.value }))
                      }
                      placeholder={t('knowledge.docSourcePlaceholder')}
                      className="h-8 text-xs"
                    />
                  </div>
                </div>
                <Textarea
                  value={draft.text}
                  onChange={(event) => setDraft((prev) => ({ ...prev, text: event.target.value }))}
                  placeholder={t('knowledge.docTextPlaceholder')}
                  className="min-h-24 text-xs"
                />
                <div className="flex justify-end">
                  <Button type="button" size="sm" disabled={saving} onClick={handleIndex}>
                    {saving ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Plus className="size-3.5" />
                    )}
                    {t('knowledge.save')}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('knowledge.close')}
          </Button>
        </div>
      </DialogContent>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => !next && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingDelete?.kind === 'knowledgeBase'
                ? t('knowledge.manager.deleteKb')
                : t('knowledge.delete')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.kind === 'knowledgeBase'
                ? t('knowledge.manager.deleteKbConfirm')
                : t('knowledge.deleteConfirm')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>{t('knowledge.delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}