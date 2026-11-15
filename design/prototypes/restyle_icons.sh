#!/bin/bash
# 把上游的彩色贴纸风图标改成 otm 的风格。
# 做法：去掉贴纸的白边，保留原图案的颜色（这是辨识度的来源），放到统一的深色底上，
#       底的形状和描边颜色表示大类。
# 用法: restyle_icons.sh <上游图标目录> <输出目录>
SRC="$1"; OUT="$2"; BG='#1b2028'
# 输出: 颜色 形状 图案尺寸
style() { case "$1" in
  container_*|loose_loot) echo '#9d8cff square 56';;
  extract_pmc) echo '#3ddc84 circle 52';; extract_scav) echo '#4da3ff circle 52';; extract_shared) echo '#2dd4bf circle 52';;
  extract_transit|btr_stop) echo '#aeb8c4 circle 52';;
  hazard*) echo '#ff5d5d triangle 44';;
  key|keycard|lock) echo '#f5a524 diamond 52';;
  quest_*) echo '#ff6ac1 hexagon 50';;
  spawn_boss|spawn_cultist-priest|spawn_rogue|spawn_bloodhound|spawn_af|spawn_black-div) echo '#ff5d5d circle 52';;
  *) echo '#8d97a5 circle 52';; esac; }
shape() { case "$1" in
  square) echo "roundrectangle 5,5 74,74 16,16";; circle) echo "circle 40,40 40,5";;
  diamond) echo "polygon 40,4 76,40 40,76 4,40";; hexagon) echo "polygon 40,4 72,22 72,58 40,76 8,58 8,22";;
  triangle) echo "polygon 40,5 76,72 4,72";; esac; }
for f in "$SRC"/*.png; do
  n=$(basename "$f" .png); read -r c sh gs <<<"$(style "$n")"
  # 把透明度向内收几个像素，去掉外圈白边，内部的白色保留。白边粗细各类不同。
  er=3.2; case "$n" in extract_*) er=5.2;; hazard*) er=1.6;; btr_stop) er=4.2;; esac
  convert "$f" -resize 64x64 -background none -gravity center -extent 80x80 \
    \( +clone -alpha extract -morphology Erode Disk:$er -blur 0x0.6 \) -alpha off -compose CopyOpacity -composite -compose Over \
    -gravity center -extent 64x64 -modulate 100,88 "$OUT/$n.in.png"
  case "$n" in
    extract_*|btr_stop)
      # 撤离点、转移点、BTR 站点：不加底，直接用上游的标志
      convert "$OUT/$n.in.png" -trim +repage -resize 72x72 -background none -gravity center -extent 80x80 "$OUT/$n.png"
      rm -f "$OUT/$n.in.png"; continue;;
    hazard*)
      # 危险区：上游的黄色三角直接放大填满，外面加一圈类别色描边
      convert "$OUT/$n.in.png" -trim +repage -resize 66x66 -background none -gravity center -extent 80x80 "$OUT/$n.t.png"
      convert "$OUT/$n.t.png" \( +clone -channel A -threshold 45% -morphology Dilate Disk:3.6 +channel -fill "$c" -colorize 100 \) \
        +swap -compose Over -composite "$OUT/$n.png"
      rm -f "$OUT/$n.in.png" "$OUT/$n.t.png"; continue;;
  esac
  off="+0+0"; [ "$sh" = triangle ] && off="+0+11"
  # 图案外面垫一圈浅色细边，深色图案（武器箱、头套）在深色底上才分得出来
  convert "$OUT/$n.in.png" -resize ${gs}x${gs} \
    \( +clone -channel A -threshold 40% -morphology Dilate Disk:1.6 +channel -fill '#c9d1da' -colorize 100 -channel A -evaluate multiply 0.75 +channel \) \
    +swap -background none -compose Over -layers merge +repage "$OUT/$n.g.png"
  convert -size 80x80 xc:none -fill "$BG" -stroke "$c" -strokewidth 4.5 -draw "$(shape "$sh")" \
    "$OUT/$n.g.png" -gravity center -geometry $off -compose Over -composite "$OUT/$n.png"
  rm -f "$OUT/$n.g.png"
  rm -f "$OUT/$n.in.png"
done
