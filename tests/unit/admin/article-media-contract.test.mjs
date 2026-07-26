import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("文章编辑器上传并保存受控图片关联，失败时保留正文", async () => {
  const page = await readFile(new URL("../../../app/admin/page.tsx", import.meta.url), "utf8");
  assert.match(page, /mediaId: type === "article" \? articleImageId/);
  assert.match(page, /文章图片上传成功，保存文章后才会关联/u);
  assert.match(page, /文章图片上传失败，正文未变更/u);
  assert.match(page, /上传文件超过服务限制，请选择更小的图片/u);
  assert.match(page, /accept="image\/jpeg,image\/png,image\/webp"/);
  assert.match(page, /移除图片/u);
});

test("文章上传运行时允许覆盖接口声明的 10 MiB 图片上限", async () => {
  const config = await readFile(new URL("../../../next.config.ts", import.meta.url), "utf8");
  assert.match(config, /bodySizeLimit: "12mb"/u);
});

test("草稿图片预览只走管理员鉴权的 no-store 媒体路由", async () => {
  const route = await readFile(new URL("../../../app/api/admin/uploads/[id]/route.ts", import.meta.url), "utf8");
  assert.match(route, /requireAdmin/);
  assert.match(route, /kind = 'image'/);
  assert.match(route, /cache-control.*private, no-store/u);
  assert.match(route, /content-disposition/);
});

test("文章和症状日历入口拥有不同的导航语义", async () => {
  const page = await readFile(new URL("../../../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /aria-label="今日待完成：打开过敏原记录"/u);
  assert.match(page, /data-navigation-purpose="allergen-record"/u);
  assert.match(page, /aria-label="打开症状评估日历"/u);
  assert.match(page, /data-navigation-purpose="symptom-calendar"/u);
  assert.match(page, /startAllergenRecord\(localDateValue\(\)\)/u);
  assert.match(page, /onClick=\{\(\) => navigateTo\("assessment"\)\}/u);
});
