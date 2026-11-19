// 样式。配色抄 design/mockups/mockup2.html 的 CSS 变量。

export const CSS = `
:root {
  --font: "Noto Sans CJK SC", "Noto Sans CJK JP", "DejaVu Sans", sans-serif;
  --bg: #14171c; --land: #1b2027; --land2: #20262e; --forest: #1c2a24; --water: #17303f;
  --road: #39414d; --bld: #2c343f; --bld-stroke: #465160;
  --panel: rgba(22,26,32,.92); --panel2: rgba(255,255,255,.05); --line: rgba(255,255,255,.08);
  --text: #dfe5ec; --muted: #8893a1; --accent: #ffd24a;
  --c-extract: #3ddc84; --c-scav: #4da3ff; --c-key: #f5a524; --c-quest: #ff6ac1; --c-loot: #9d8cff; --c-boss: #ff5d5d; --c-spawn: #7d8794;
  --c-transit: #ff5d5d; --c-shared: #46d6cf; --c-warn: #ffd24a; --c-danger: #ff5d5d;
  --c-season: #4da3ff;
  --me: #ffffff;
}
* { box-sizing: border-box; }
html, body, #root { margin: 0; height: 100%; overflow: hidden; }
body { font-family: var(--font); color: var(--text); background: var(--bg); -webkit-font-smoothing: antialiased; }
button { font: inherit; color: inherit; background: none; border: none; padding: 0; cursor: pointer; }
.pill { background: var(--panel); border: 1px solid var(--line); }
.app { position: fixed; inset: 0; }
/* 地图自己成一个层叠上下文，否则 Leaflet 的 pane（z-index 400+）会盖住界面 */
.map { position: absolute; inset: 0; z-index: 0; isolation: isolate; }
/* 出错时的占位：只有一个小重试按钮，不写说明 */
.crash { position: absolute; inset: 0; display: grid; place-items: center; background: var(--bg); }
.crash.full { position: fixed; }

/* 地图上的标注 */
.otm-anno img { display: block; filter: drop-shadow(0 1px 2px rgba(0,0,0,.7)); }
.otm-anno:hover img { filter: drop-shadow(0 0 5px rgba(255,255,255,.55)) brightness(1.15); }
/* 赛季文件：文件形状的徽章，边框按种类上色（v2-season.png） */
.otm-doc {
  position: relative; display: block; box-sizing: border-box; border-style: solid;
  border-color: var(--c); background: rgba(17,20,26,.92); color: #e9eff8;
  box-shadow: 0 1px 4px rgba(0,0,0,.6);
}
.otm-doc svg { position: absolute; inset: 13%; width: 74%; height: 74%; }
.otm-doc-anno:hover .otm-doc { filter: brightness(1.15); box-shadow: 0 0 7px rgba(255,255,255,.4); }
/* 合并标注：图标 + 数量角标，后面两层错开的淡轮廓（v2-cluster.png） */
.otm-stack { position: relative; }
.otm-stack .st {
  position: absolute; display: block; border: 1.5px solid var(--c);
  background: rgba(22,26,32,.55);
}
.otm-stack .st2 { opacity: .35; }
.otm-stack .st1 { opacity: .62; }
.otm-stack .st0 { background: rgba(22,26,32,.9); }
.otm-stack img { position: absolute; display: block; }
.otm-stack .cnt {
  position: absolute; display: block; border-radius: 999px; background: var(--c); color: #14171c;
  font-weight: 700; text-align: center; letter-spacing: -.2px;
  box-shadow: 0 1px 4px rgba(0,0,0,.55);
}
.otm-cluster { cursor: pointer; }
.otm-cluster:hover .st0 { background: rgba(38,45,55,.95); }
.otm-cluster:hover .cnt { filter: brightness(1.12); }
.otm-me { position: relative; }
.otm-me .arrow { position: absolute; inset: 0; display: grid; place-items: center; }
.otm-me .arrow svg { fill: #fff; stroke: #14171c; stroke-width: 1.2; filter: drop-shadow(0 0 4px rgba(255,255,255,.5)); }
.otm-me .dot { position: absolute; left: 7px; top: 7px; width: 10px; height: 10px; border-radius: 50%; background: #fff; box-shadow: 0 0 0 3px rgba(255,255,255,.25); }
.otm-me .cone {
  position: absolute; left: 50%; top: 50%; width: 150px; height: 150px; margin: -75px 0 0 -75px;
  clip-path: polygon(50% 50%, 36% 0, 64% 0);
  background: linear-gradient(to top, rgba(255,255,255,0), rgba(255,255,255,.22));
  transform-origin: 50% 50%; pointer-events: none;
}
.otm-me.stale .arrow svg { fill: var(--accent); stroke: #14171c; filter: drop-shadow(0 0 5px rgba(255,210,74,.55)); }
.otm-me.stale .dot { background: var(--accent); box-shadow: 0 0 0 3px rgba(255,210,74,.3); }
.otm-stale-label {
  display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px; border-radius: 15px;
  background: var(--accent); color: #14171c; font-size: 14px; font-weight: 700; white-space: nowrap;
  box-shadow: 0 2px 10px rgba(0,0,0,.5); width: max-content !important; height: 30px !important;
}
.otm-stale-label svg { flex: none; }

/* 预设 chip */
.presets { position: absolute; top: 24px; left: 24px; display: flex; gap: 8px; align-items: center; }
.chip { height: 38px; padding: 0 16px; border-radius: 19px; display: flex; align-items: center; gap: 8px; font-size: 16px; color: var(--muted); background: var(--panel); border: 1px solid var(--line); }
.chip.on { color: #14171c; background: var(--accent); border-color: var(--accent); font-weight: 700; }
.chip.add { width: 38px; padding: 0; justify-content: center; font-size: 20px; }
.chip input { width: 96px; background: none; border: none; outline: none; color: inherit; font: inherit; }

/* 左侧筛选 */
.filters { position: absolute; top: 78px; left: 24px; width: 236px; padding: 10px; border-radius: 14px; background: var(--panel); border: 1px solid var(--line); }
.frow { display: flex; align-items: center; gap: 12px; height: 40px; padding: 0 8px; border-radius: 8px; font-size: 16px; width: 100%; text-align: left; }
.frow:hover { background: rgba(255,255,255,.04); }
.frow.off { opacity: .35; }
.frow .n { margin-left: auto; color: var(--muted); font-size: 14px; }
.frow img { width: 22px; height: 22px; flex: none; }
.frow .car { color: var(--muted); font-size: 11px; margin-left: 2px; }
.sep { height: 1px; background: var(--line); margin: 8px 4px; }
.sw { margin-left: auto; width: 34px; height: 20px; border-radius: 10px; background: var(--accent); position: relative; flex: none; }
.sw::after { content: ""; position: absolute; top: 3px; right: 3px; width: 14px; height: 14px; border-radius: 50%; background: #14171c; }
.sw.off { background: rgba(255,255,255,.14); } .sw.off::after { right: auto; left: 3px; background: #8893a1; }
.subs { display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 12px 12px 46px; }
.sc { height: 28px; padding: 0 12px; border-radius: 14px; display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); border: 1px solid rgba(255,255,255,.12); }
.sc img { width: 14px; height: 14px; }
.sc.on { color: #14171c; background: var(--c-loot); border-color: var(--c-loot); font-weight: 600; }
.sc.on.spawn { background: var(--c-spawn); }
.sc.on.extract { background: var(--c-extract); }
.sc.on.hazard { background: var(--warn); }
.sc.season { color: var(--c, var(--c-season)); }
.sc.season.on { background: var(--c, var(--c-season)); border-color: var(--c, var(--c-season)); color: #14171c; }

/* 右上工具 */
.tools { position: absolute; top: 24px; right: 24px; display: flex; gap: 8px; align-items: center; }
.ib { width: 38px; height: 38px; border-radius: 50%; display: grid; place-items: center; color: var(--muted); background: var(--panel); border: 1px solid var(--line); }
.ib.on { color: #14171c; background: var(--accent); border-color: var(--accent); }
.ib svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.seg { display: flex; height: 38px; border-radius: 19px; padding: 3px; gap: 2px; font-size: 14px; background: var(--panel); border: 1px solid var(--line); }
.seg span { padding: 0 14px; border-radius: 16px; display: grid; place-items: center; color: var(--muted); }
.seg span.on { background: rgba(255,255,255,.12); color: var(--text); }
.seg span.dis { opacity: .3; }

/* 右侧楼层 */
.floors { position: absolute; right: 24px; top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; gap: 6px; padding: 8px; border-radius: 14px; background: rgba(22,26,32,.94); border: 1px solid rgba(255,255,255,.1); box-shadow: 0 12px 34px rgba(0,0,0,.55); max-height: 70vh; overflow: auto; }
.fl { width: 44px; height: 40px; border-radius: 8px; display: grid; place-items: center; font-size: 15px; color: var(--muted); }
.fl:hover { background: rgba(255,255,255,.06); color: var(--text); }
.fl.on { background: var(--accent); color: #14171c; font-weight: 700; }
.fl.on:hover { background: var(--accent); color: #14171c; }
.fl.auto { box-shadow: inset 0 0 0 1px rgba(255,210,74,.5); }

/* 状态栏 */
.status { position: absolute; left: 24px; bottom: 24px; display: flex; gap: 14px; align-items: center; height: 38px; padding: 0 16px; border-radius: 19px; font-size: 15px; color: var(--muted); background: var(--panel); border: 1px solid var(--line); }
.status b { color: var(--text); font-weight: 600; }
.status .mapbtn { display: flex; align-items: center; gap: 6px; color: var(--text); font-weight: 600; }
.status .mapbtn:hover { color: var(--accent); }
.status .mapbtn svg { width: 12px; height: 12px; fill: currentColor; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c-extract); flex: none; }
.dot.gray { background: #5d6672; }
.dot.yellow { background: var(--accent); box-shadow: 0 0 0 4px rgba(255,210,74,.25); }
.dot.red { background: var(--c-danger); }
.status .seas { display: flex; align-items: center; gap: 5px; color: var(--muted); border-left: 1px solid var(--line); padding-left: 14px; margin-left: -2px; }
.status .seas img { width: 18px; height: 18px; display: block; }
.status .seas b { color: var(--c-season); font-weight: 700; }
.status .seas .of { font-size: 14px; }
.status svg.ic { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.status .warn { color: var(--accent); display: flex; align-items: center; gap: 6px; }
.status .err { color: var(--c-danger); display: flex; align-items: center; gap: 8px; }

/* 地图列表 */
.maplist { position: absolute; left: 24px; bottom: 76px; width: 430px; padding: 10px; border-radius: 14px; background: var(--panel); border: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: 6px; }
.maplist span { height: 32px; padding: 0 12px; border-radius: 8px; display: grid; place-items: center; font-size: 14px; background: var(--panel2); color: var(--text); }
.maplist span.on { background: var(--accent); color: #14171c; font-weight: 700; }

/* 标注卡片 */
.card { position: absolute; width: 250px; padding: 12px 14px; border-radius: 12px; font-size: 14px; background: var(--panel); border: 1px solid var(--line); box-shadow: 0 10px 30px rgba(0,0,0,.5); }
.card h4 { margin: 0 0 6px; font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.card h4 img { width: 20px; height: 20px; }
.card .meta { color: var(--muted); display: flex; gap: 10px; align-items: center; }
.card .pin { margin-left: auto; color: var(--accent); }
.card .tagc { padding: 1px 8px; border-radius: 9px; background: rgba(255,255,255,.08); color: var(--text); font-size: 13px; }
.card .close { position: absolute; right: 8px; top: 6px; color: var(--muted); font-size: 18px; line-height: 1; }

/* 合并标注的悬停列表 */
.ccluster { width: auto; min-width: 196px; padding: 8px 12px; }
.ccluster .crow { display: flex; align-items: center; gap: 10px; height: 30px; font-size: 14px; }
.ccluster .crow img { width: 20px; height: 20px; flex: none; }
.ccluster .crow span { white-space: nowrap; }
.ccluster .crow b { margin-left: auto; padding-left: 14px; color: var(--muted); font-weight: 500; }

/* 设置面板 */
.dim { position: absolute; inset: 0; background: rgba(8,10,13,.6); }
/* 赛季文件详情：右侧抽屉（v2-d-doc.png） */
.drawer { position: absolute; right: 8px; top: 8px; bottom: 8px; width: 470px; border-radius: 22px; display: flex; flex-direction: column; background: #171b21; border: 1px solid var(--line); box-shadow: -24px 0 80px rgba(0,0,0,.55); overflow: hidden; }
.dh { display: flex; align-items: center; gap: 14px; padding: 20px 22px 16px; }
.dback { width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; color: var(--muted); background: rgba(255,255,255,.05); flex: none; }
.dback:hover { color: var(--text); }
.ditem { width: 52px; height: 52px; object-fit: contain; border-radius: 10px; background: rgba(255,255,255,.05); padding: 6px; flex: none; }
.dtt { font-size: 22px; font-weight: 700; }
.dst { font-size: 13px; color: var(--muted); margin-top: 2px; }
.drow { display: flex; align-items: center; gap: 12px; padding: 10px 22px; border-top: 1px solid var(--line); font-size: 15px; }
.dkey { color: var(--muted); width: 64px; flex: none; }
.dms { display: flex; gap: 8px; flex-wrap: wrap; }
.mc { height: 30px; padding: 0 14px; border-radius: 15px; font-size: 14px; color: var(--muted); background: rgba(255,255,255,.04); border: 1px solid var(--line); }
.mc:hover { color: var(--text); }
.mc.on { color: #14171c; background: var(--accent); border-color: var(--accent); font-weight: 700; }
.dtoday { font-size: 16px; }
.dtoday b { font-size: 20px; font-weight: 700; }
.cnt2 { margin-left: auto; display: flex; gap: 8px; }
.cnt2 button { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; font-size: 16px; color: var(--text); background: rgba(255,255,255,.06); }
.cnt2 button:hover { background: rgba(255,255,255,.12); }
.cnt2 button:disabled { opacity: .3; }
.dsec { display: flex; align-items: baseline; gap: 8px; padding: 14px 22px 8px; color: var(--muted); font-size: 13px; }
.dsec .n { margin-left: auto; }
.dplist { flex: 1; overflow: auto; padding: 0 16px 12px; display: flex; flex-direction: column; gap: 4px; }
.dp { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; padding: 8px; border-radius: 12px; }
.dp:hover { background: rgba(255,255,255,.04); }
.dp.on { display: block; background: rgba(255,255,255,.05); padding: 12px; }
.phb { display: grid; place-items: center; width: 56px; height: 56px; border-radius: 8px; background: rgba(255,255,255,.05); overflow: hidden; flex: none; }
.phb img { width: 100%; height: 100%; object-fit: cover; }
.dp.on .phb { width: 100%; height: 220px; border-radius: 12px; }
.dpd { flex: 1; font-size: 14px; line-height: 1.45; }
.dp.on .dpd { flex: none; margin-top: 12px; font-size: 15px; }
.dpf { display: flex; align-items: center; gap: 8px; flex: none; }
.dp.on .dpf { margin-top: 10px; }
.fc { height: 22px; padding: 0 8px; border-radius: 6px; display: inline-grid; place-items: center; font-size: 12px; color: var(--muted); background: rgba(255,255,255,.08); }
.dpm { font-size: 13px; color: var(--muted); }
.dp.on .dpm { margin-left: auto; }
.dempty { color: var(--muted); font-size: 14px; padding: 12px 8px; }
.src { padding: 10px 22px 16px; border-top: 1px solid var(--line); font-size: 12px; color: var(--muted); }
.src a { color: var(--muted); text-decoration: none; }
.src a:hover { color: var(--text); text-decoration: underline; }

.sheet { position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%); width: 900px; height: 620px; border-radius: 18px; display: flex; overflow: hidden; background: #171b21; border: 1px solid var(--line); box-shadow: 0 30px 90px rgba(0,0,0,.6); }
.tabs { width: 170px; padding: 18px 10px; border-right: 1px solid var(--line); display: flex; flex-direction: column; gap: 4px; }
.tab { height: 40px; padding: 0 14px; border-radius: 8px; display: flex; align-items: center; font-size: 15px; color: var(--muted); text-align: left; }
.tab.on { background: rgba(255,255,255,.08); color: var(--text); font-weight: 600; }
.sbody { flex: 1; padding: 22px 28px; overflow: auto; }
.row { display: flex; align-items: center; height: 46px; font-size: 15px; border-bottom: 1px solid rgba(255,255,255,.04); gap: 10px; }
.row .r { margin-left: auto; display: flex; gap: 6px; align-items: center; }
.h { font-size: 12px; color: var(--muted); letter-spacing: 1px; margin: 4px 2px 8px; }
.plist { width: 190px; padding-right: 18px; margin-right: 22px; border-right: 1px solid var(--line); display: flex; flex-direction: column; gap: 4px; flex: none; }
.pi { height: 42px; padding: 0 12px; border-radius: 8px; display: flex; align-items: center; gap: 10px; font-size: 15px; color: var(--muted); text-align: left; }
.pi.on { background: rgba(255,255,255,.08); color: var(--text); font-weight: 600; }
.pi .k { margin-left: auto; font-size: 12px; font-weight: 400; color: var(--muted); }
.name { height: 40px; padding: 0 12px; border-radius: 8px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1); display: flex; align-items: center; font-size: 16px; flex: 1; }
.name input { background: none; border: none; outline: none; color: inherit; font: inherit; width: 100%; }
.del { color: var(--c-boss); font-size: 14px; }
.tree { display: flex; flex-direction: column; gap: 4px; margin: 6px 0 16px; }
.g { border-radius: 10px; background: var(--panel2); }
.g.off .gh { opacity: .4; }
.gh { height: 40px; padding: 0 12px; display: flex; align-items: center; gap: 10px; font-size: 15px; width: 100%; text-align: left; }
.gh img { width: 20px; height: 20px; }
.gh .cnt { color: var(--muted); font-size: 12px; margin-left: 4px; }
.gh .car { color: var(--muted); font-size: 12px; margin-left: auto; }
.subs2 { display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 12px 12px 46px; }
.prow { display: flex; gap: 22px; }
.slider { width: 220px; height: 4px; border-radius: 2px; background: rgba(255,255,255,.12); position: relative; }
.slider i { position: absolute; left: 0; top: 0; height: 100%; border-radius: 2px; background: var(--accent); }
.slider b { position: absolute; top: -6px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transform: translateX(-8px); }
.val { width: 48px; text-align: right; color: var(--muted); font-size: 13px; }
.note { margin-top: 14px; font-size: 13px; color: var(--muted); }
.kv { display: flex; gap: 10px; align-items: center; font-size: 14px; color: var(--muted); height: 40px; }
.kv b { color: var(--text); font-weight: 500; }
.kv .link { color: var(--c-season); text-decoration: none; }
.kv .link:hover { text-decoration: underline; }
.bad { color: var(--c-danger); }
.good { color: var(--c-extract); }
`;
