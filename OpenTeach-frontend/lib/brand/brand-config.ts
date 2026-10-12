/**
 * Brand configuration.
 *
 * The reference (live deployment) resolves the brand per vendor from the
 * desktop shell's User-Agent token. This workspace has no vendor shell: the
 * product ships with its own single brand, so the config is static and the
 * desktop flag is always off. The shape is kept so surfaces that read the
 * brand (home hero, workspace rail, site header) keep one source of truth.
 */

export interface BrandConfig {
  /** Full product name (page titles, logo alt text). */
  productName: string;
  /** Short name for space-constrained spots. */
  shortName: string;
  /** Brand lockup asset under `public/`. */
  logoSrc: string;
  /** Whether `logoSrc` already carries the product wordmark. */
  logoHasWordmark: boolean;
  /** The mark alone, without a wordmark, under `public/`. */
  markSrc: string;
  /** Browser theme color (`<meta name="theme-color">` / PWA). */
  themeColor: string;
}

/** The default brand: the product itself, with no vendor overrides. */
export const DEFAULT_BRAND: BrandConfig = {
  productName: 'OpenTeach',
  shortName: 'OpenTeach',
  // 上游的 /logo-horizontal.png 把「OpenMAIC」字标烘焙进位图，本仓库已删除该资源；
  // 字标改由各界面用文字渲染（图形标记 + 产品名），位图只承担图形部分。
  logoSrc: '/openteach-mark.png',
  logoHasWordmark: false,
  markSrc: '/openteach-mark.png',
  themeColor: '#722ed1',
};
