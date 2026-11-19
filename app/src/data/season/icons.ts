// 赛季文件的物品图（8 种文件各一张 64×64）。
//
// 这些图原来放在 public/icons 里、用相对路径引用。实机上抽屉标题左边那张是空的，
// 同一页的远端照片却正常，所以不是图本身或布局的问题，是 public 目录里这些文件的
// 加载方式在 WebView2 下不成立。改成从 src/assets 导入，由 Vite 打成带哈希的资源，
// 和脚本一起被 Tauri 嵌进程序里，路径也是 Vite 生成的那种，不再靠目录约定。
//
// 再进一步：用 ?inline 让 Vite 直接把图编成 data URI 塞进脚本，运行时一个请求都不发，
// 把"路径对不对、协议认不认"这条可能性整个去掉。
//
// 包里换了物品 id（比如换赛季）就没有对应的图，返回 null，界面画文件形状的徽章兜底。

import pmc from "../../assets/season/doc_6a317b9692cfdcddcb02a58e.png?inline";
import finance from "../../assets/season/doc_6a31807f17005505b70d5827.png?inline";
import project from "../../assets/season/doc_6a3181f178450ec91c0ea1aa.png?inline";
import blueprint from "../../assets/season/doc_6a31824878450ec91c0ea1ae.png?inline";
import test from "../../assets/season/doc_6a31828557705071410ca00e.png?inline";
import staff from "../../assets/season/doc_6a3182b72fd891345e047eef.png?inline";
import medical from "../../assets/season/doc_6a3182dc6cd8de21cf0a3a7d.png?inline";
import technical from "../../assets/season/doc_6a31830dde69ceafd805afa0.png?inline";

const BY_ITEM: Record<string, string> = {
  "6a317b9692cfdcddcb02a58e": pmc,
  "6a31807f17005505b70d5827": finance,
  "6a3181f178450ec91c0ea1aa": project,
  "6a31824878450ec91c0ea1ae": blueprint,
  "6a31828557705071410ca00e": test,
  "6a3182b72fd891345e047eef": staff,
  "6a3182dc6cd8de21cf0a3a7d": medical,
  "6a31830dde69ceafd805afa0": technical,
};

/** 物品图的地址；这个物品 id 没有图就是 null。 */
export function itemIcon(item: string | null | undefined): string | null {
  if (!item) return null;
  return BY_ITEM[item] ?? null;
}
