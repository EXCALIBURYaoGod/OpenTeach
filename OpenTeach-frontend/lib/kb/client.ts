/**
 * 知识库（KB）API 客户端。
 *
 * 请求全部走相对路径 `/api/kb/*`：设置 `OPENTEACH_API_BASE` 后由
 * `next.config.ts` 的 `beforeFiles` 重写代理到 OpenTeach 后端；未设置时
 * 这些路径在本应用内不存在（404），`probeKnowledgeBase()` 因此返回
 * `available: false`，界面据此隐藏知识库入口 —— 与仓库既有的
 * 「后端未实现的入口一律隐藏」约定一致。
 *
 * 响应信封沿用 OpenTeach 的 `{ success: true, ...data }` /
 * `{ success: false, errorCode, error }`（见 `lib/server/api-response.ts`）。
 *
 * @module kb/client
 */

import { createLogger } from '@/lib/logger';
import type {
  KbDocument,
  KbIndexInput,
  KbSearchInput,
  KbSearchResult,
  KbStatus,
} from './types';

const log = createLogger('KB');

const KB_ENDPOINT = '/api/kb';

interface KbEnvelope {
  success?: boolean;
  error?: string;
  errorCode?: string;
  data?: unknown;
}

/** 发一次 KB 请求并拆信封：非 2xx 或 `success !== true` 一律抛出可读错误。 */
async function callJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${KB_ENDPOINT}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  const body = (await response.json().catch(() => null)) as KbEnvelope | null;

  if (!response.ok || body?.success !== true) {
    throw new Error(
      body?.error || body?.errorCode || `知识库请求失败（HTTP ${response.status}）`,
    );
  }

  return (body.data ?? {}) as T;
}

/** 列出已存在的知识库名。 */
export async function listKnowledgeBases(signal?: AbortSignal): Promise<string[]> {
  const data = await callJson<{ knowledgeBases?: string[] }>('/knowledge-bases', { signal });
  return data.knowledgeBases ?? [];
}

/**
 * 探针：知识库服务是否可用（后端是否装配了 `@openteach/plugin-kb`）。
 * 失败不抛错，只记一条告警并返回不可用 —— 调用方据此隐藏入口。
 */
export async function probeKnowledgeBase(signal?: AbortSignal): Promise<KbStatus> {
  try {
    return { available: true, knowledgeBases: await listKnowledgeBases(signal) };
  } catch (error) {
    log.warn('知识库服务不可用（后端未装配 kb 插件，或 /api/kb 未被代理）:', error);
    return { available: false, knowledgeBases: [] };
  }
}

/** 列出某知识库的文档。 */
export async function listKbDocuments(
  kbName: string,
  signal?: AbortSignal,
): Promise<KbDocument[]> {
  const data = await callJson<{ documents?: KbDocument[] }>(
    `/${encodeURIComponent(kbName)}/documents`,
    { signal },
  );
  return data.documents ?? [];
}

/** 索引一篇文档（切分 + 建索引由后端完成）。 */
export async function indexKbDocument(input: KbIndexInput): Promise<KbDocument> {
  const data = await callJson<{ document: KbDocument }>('/index', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return data.document;
}

/** 删除文档及其分块。 */
export async function deleteKbDocument(kbName: string, documentId: string): Promise<boolean> {
  const data = await callJson<{ removed?: boolean }>(
    `/${encodeURIComponent(kbName)}/documents/${encodeURIComponent(documentId)}`,
    { method: 'DELETE' },
  );
  return data.removed === true;
}

/** 检索：命中片段 + 后端拼好的 `context`（可直接注入课堂生成）。 */
export async function searchKnowledgeBase(input: KbSearchInput): Promise<KbSearchResult> {
  return callJson<KbSearchResult>('/search', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}