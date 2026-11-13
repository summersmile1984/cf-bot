// 根 wrangler.jsonc 快照（open-source-split S2.3）：mastra build（CloudflareDeployer）会重写根配置，
// Deploy to Cloudflare 按钮/用户自定义的 name/资源名/ID 必须在构建前存一份，postbuild 以快照为准同步。
import { copyFileSync, existsSync } from 'node:fs';
if (existsSync('wrangler.jsonc')) {
  copyFileSync('wrangler.jsonc', '.cf-root-config.json');
  console.log('[cf-prebuild] root wrangler.jsonc snapshotted');
}
