// ?inline 后缀的图片：Vite 直接编成 data URI（见 src/data/season/icons.ts）
declare module "*.png?inline" {
  const src: string;
  export default src;
}
