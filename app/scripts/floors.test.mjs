#!/usr/bin/env node
// 楼层归属的单元测试：node scripts/floors.test.mjs
//
// 只测规则本身（高度区间 + 区域框），用一份手写的小样本，不联网、不碰 Leaflet。
// 真实数据上「切到某层只剩这层的东西」由 scripts/map-regression.mjs 端到端覆盖。

import assert from "node:assert/strict";
import { GROUND, annotationLayer, layerOfPoint, onLayer } from "../src/data/floors.ts";

let n = 0;
function ok(name, fn) {
  fn();
  n++;
  console.log(`✓ ${name}`);
}

// 两层：二楼有高度区间 + 区域框（只覆盖 x 0..10 / z 0..10），三楼只有高度区间
const meta = {
  layers: [
    { name: "2nd Floor", extents: [{ height: [3, 6], bounds: [[[0, 0], [10, 10]]] }] },
    { name: "3rd Floor", extents: [{ height: [6, 9] }] },
  ],
};

ok("高度落在二楼区间、位置也在区域框里 → 二楼", () => {
  assert.equal(layerOfPoint(meta.layers, { x: 5, y: 4, z: 5 }), 0);
});

ok("高度对但位置在区域框外 → 哪层都不是（地面）", () => {
  assert.equal(layerOfPoint(meta.layers, { x: 40, y: 4, z: 40 }), GROUND);
});

ok("区域框的角点算在里面", () => {
  assert.equal(layerOfPoint(meta.layers, { x: 0, y: 4, z: 10 }), 0);
});

ok("没有 bounds 的层整张图都算", () => {
  assert.equal(layerOfPoint(meta.layers, { x: 999, y: 7, z: 999 }), 1);
});

ok("高度区间是 [h0, h1)：上沿归下一层，不归这一层", () => {
  assert.equal(layerOfPoint(meta.layers, { x: 5, y: 5.99, z: 5 }), 0);
  assert.equal(layerOfPoint(meta.layers, { x: 5, y: 6, z: 5 }), 1);
  // 9 是最后一层的上沿，上面没有别的层了
  assert.equal(layerOfPoint(meta.layers, { x: 5, y: 9, z: 5 }), GROUND);
});

ok("没有楼层配置的地图 → 全是地面", () => {
  assert.equal(layerOfPoint(undefined, { x: 5, y: 4, z: 5 }), GROUND);
  assert.equal(layerOfPoint([], { x: 5, y: 4, z: 5 }), GROUND);
});

ok("给了 top/bottom 时用整段高度判断，不看 position.y", () => {
  // 从 1 层跨到 4 层：下沿不在二楼区间里，就不算二楼
  assert.equal(layerOfPoint(meta.layers, { x: 5, y: 4, z: 5 }, 1, 4), GROUND);
  assert.equal(layerOfPoint(meta.layers, { x: 5, y: 4, z: 5 }, 3, 5), 0);
});

ok("标注用 top/bottom，没有就用 position.y", () => {
  assert.equal(annotationLayer(meta, { x: 5, y: 4, z: 5 }), 0);
  assert.equal(annotationLayer(meta, { x: 5, y: 4, z: 5, top: 3, bottom: 5 }), 0);
  assert.equal(annotationLayer(meta, { x: 5, y: 4, z: 5, top: 1, bottom: 4 }), GROUND);
});

ok("onLayer 只认当前这一层：别的层、地面都不算", () => {
  assert.equal(onLayer(meta, 0, { x: 5, y: 4, z: 5 }), true);
  assert.equal(onLayer(meta, 1, { x: 5, y: 4, z: 5 }), false);
  assert.equal(onLayer(meta, GROUND, { x: 5, y: 4, z: 5 }), false);
  assert.equal(onLayer(meta, GROUND, { x: 40, y: 4, z: 40 }), true);
});

console.log(`\n共 ${n} 项，全部通过`);
