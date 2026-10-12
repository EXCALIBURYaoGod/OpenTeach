'use client';

/**
 * 知识库管理弹窗。
 *
 * 后端契约来自 `@openteach/plugin-kb`（`/api/kb/*`）。后端没有「创建空知识库」
 * 的接口 —— 知识库在首次入库文档时随之产生，因此「新建知识库」只是本地选中一个
 * 尚未存在的库名，随后由「索引文档」把它真正建出来。
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
  deleteKbDocument,
  indexKbDocument,
  listKbDocuments,
  probeKnowledgeBase,
} from '@/lib/kb/client';
import type { KbDocument } from '@/lib/kb/types';
import { cn } from '@/lib/utils';

const log = createLogger('KnowledgeManager');

/** 与后端 `KB_NAME_PATTERN` 一致：挡路径穿越，也避免建出无法访问的库。 */
const KB_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

interface KnowledgeManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前用于生成的知识库名；弹窗内切换会回调给调用方。 */
  activeKbName?: string;
  onActiveKbNameChange?: (kbName: string) => void;
}

export function KnowledgeManagerDialog({
  open,
  onOpenChange,
  activeKbName,
  onActiveKbNameChange,
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
  const [pendingDelete, setPendingDelete] = useState<KbDocument | null>(null);

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
    return status;
  }, []);

  // 打开时探针 + 拉库列表。所有 setState 都在 await 之后，避免在 effect 里同步置态。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      setProbing(true);
      const status = await reloadKnowledgeBases();
      if (cancelled) return;
      setSelectedKb((prev) => prev || activeKbName || status.knowledgeBases[0] || '');
      setProbing(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, activeKbName, reloadKnowledgeBases]);

  useEffect(() => {
    if (!open || !selectedKb) return;
    void reloadDocuments(selectedKb);
  }, [open, selectedKb, reloadDocuments]);

  const selectKb = (kbName: string) => {
    setSelectedKb(kbName);
    onActiveKbNameChange?.(kbName);
  };

  const handleCreateKb = () => {
    const name = newKbName.trim();
    if (!KB_NAME_PATTERN.test(name)) {
      toast.error(t('knowledge.nameInvalid'));
      return;
    }
    if (!knowledgeBases.includes(name)) {
      setKnowledgeBases((prev) => [...prev, name].sort());
    }
    setNewKbName('');
    selectKb(name);
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
    if (!target || !selectedKb) return;
    try {
      await deleteKbDocument(selectedKb, target.id);
      await reloadDocuments(selectedKb);
      toast.success(t('knowledge.manager.deleted'));
    } catch (error) {
      log.error('删除文档失败:', error);
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
              <p className="text-xs font-medium text-muted-foreground">{t('knowledge.kbList')}</p>
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
                      handleCreateKb();
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
                  onClick={handleCreateKb}
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
                        onClick={() => setPendingDelete(document)}
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
            <AlertDialogTitle>{t('knowledge.delete')}</AlertDialogTitle>
            <AlertDialogDescription>{t('knowledge.deleteConfirm')}</AlertDialogDescription>
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