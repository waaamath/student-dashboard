'use strict';

// 練習獸素材對照表：換正式美術只改這個檔（與 pet/ 底下的圖），程式不用動。
//
// 選圖順序（第一個找得到的）：
//   species＋stage＋state → species＋stage＋'*' → '*'＋stage＋state → '*'＋stage＋'*' → missing
//   species：後端的 species_id（sp01～sp05，蛋階段是 null）
//   stage：'egg' | 'young'（之後的進化階段直接加）
//   state：'idle' | 'happy'（最近 24 小時拿到獎勵）；之後要加表情就加新值，沒有對應圖時自動用 '*'
//
// 每張圖：
//   src     相對這個檔案（web/pet/）的路徑。建議透明背景 PNG 或 SVG，正方形畫布，角色腳底貼齊畫布底部附近
//   scale   角色在顯示框裡的寬度比例（0～1），預設 0.8
//   offsetY 往上移動，佔顯示框高度的比例（0～1），預設 0；畫布底部留白不同時用來對齊地面
//   alt     替代文字
// 顯示框（stage）固定比例；名字、等級等文字放在框外，圖片大小不會影響排版。

window.PET_ASSETS = {
  version: 'storybook-young-1',
  base: document.currentScript ? new URL('.', document.currentScript.src).href : 'pet/',   // src 的基準位置
  stage: { width: 240, height: 240 },
  missing: { src: 'placeholder/missing.svg', scale: 0.8, alt: '尚無素材' },
  species: {
    sp01: { label: '芽芽狐' },   // 探索：葉耳與新芽，喜歡試試看。
    sp02: { label: '磐磐龜' },   // 堅持：卵石頭冠與暖色龜殼，穩穩前進。
    sp03: { label: '泡泡螈' },   // 創意：水滴形外鰓與波浪尾鰭，換個角度想。
    sp04: { label: '晶晶鴞' },   // 精準：晶羽與明亮雙眼，細心觀察。
    sp05: { label: '絨絨獺' },   // 合作：圓耳、綠色胸絨與張開的雙手，歡迎討論。
  },
  // 原創美術：內建 imagegen 生成（原圖 1254×1254），縮成 512×512 RGBA；透明背景，無內嵌文字與地面。
  // 統一提示：柔和水彩童話質感、藍灰圓潤描邊、奶油色外緣、全身幼獸、無配件。
  // 五種造型提示：薄荷葉耳狐／琥珀卵石龜／薰衣草粉鰓螈／天藍晶羽鴞／杏色圓耳獺。
  // happy 以各自 idle 為參考，只改笑眼、嘴型與慶祝手勢；保留體型、配色、腳底基線。
  // 共用蛋：奶油色蛋殼、新芽壓紋與呼應五種角色的五色斑紋。
  // offsetY = 0.11 - scale × (1 - 腳底像素 / 畫布高度)，對齊既有 CSS 的 89% 地面。
  // 每種的 '*' 重用 idle，讓未來新增、尚未繪製的表情仍可顯示同種角色。
  items: [
    { species: '*', stage: 'egg', state: '*', src: 'egg.png', scale: 0.78, offsetY: 0.0696, alt: '帶有新芽壓紋與五色斑紋的練習獸蛋' },
    { species: 'sp01', stage: 'young', state: 'idle', src: 'sp01-young-idle.png', scale: 0.9, offsetY: 0.0547, alt: '芽芽狐：薄荷綠葉耳與新芽，好奇地微笑' },
    { species: 'sp01', stage: 'young', state: 'happy', src: 'sp01-young-happy.png', scale: 0.9, offsetY: 0.0555, alt: '芽芽狐開心地瞇眼笑，舉起雙手慶祝' },
    { species: 'sp01', stage: 'young', state: '*', src: 'sp01-young-idle.png', scale: 0.9, offsetY: 0.0547, alt: '芽芽狐：薄荷綠葉耳與新芽，好奇地微笑' },
    { species: 'sp02', stage: 'young', state: 'idle', src: 'sp02-young-idle.png', scale: 0.9, offsetY: 0.0555, alt: '磐磐龜：琥珀色卵石頭冠與龜殼，穩穩站立' },
    { species: 'sp02', stage: 'young', state: 'happy', src: 'sp02-young-happy.png', scale: 0.9, offsetY: 0.0562, alt: '磐磐龜開心地瞇眼笑，舉起小拳頭慶祝' },
    { species: 'sp02', stage: 'young', state: '*', src: 'sp02-young-idle.png', scale: 0.9, offsetY: 0.0555, alt: '磐磐龜：琥珀色卵石頭冠與龜殼，穩穩站立' },
    { species: 'sp03', stage: 'young', state: 'idle', src: 'sp03-young-idle.png', scale: 0.9, offsetY: 0.0641, alt: '泡泡螈：淡紫身體、粉色外鰓與波浪尾鰭，微笑站立' },
    { species: 'sp03', stage: 'young', state: 'happy', src: 'sp03-young-happy.png', scale: 0.9, offsetY: 0.0662, alt: '泡泡螈開心地瞇眼笑，向兩側展開小手' },
    { species: 'sp03', stage: 'young', state: '*', src: 'sp03-young-idle.png', scale: 0.9, offsetY: 0.0641, alt: '泡泡螈：淡紫身體、粉色外鰓與波浪尾鰭，微笑站立' },
    { species: 'sp04', stage: 'young', state: 'idle', src: 'sp04-young-idle.png', scale: 0.9, offsetY: 0.0598, alt: '晶晶鴞：天藍色晶羽與奶油色臉盤，專心觀察' },
    { species: 'sp04', stage: 'young', state: 'happy', src: 'sp04-young-happy.png', scale: 0.9, offsetY: 0.0605, alt: '晶晶鴞開心地瞇眼笑，展開雙翅慶祝' },
    { species: 'sp04', stage: 'young', state: '*', src: 'sp04-young-idle.png', scale: 0.9, offsetY: 0.0598, alt: '晶晶鴞：天藍色晶羽與奶油色臉盤，專心觀察' },
    { species: 'sp05', stage: 'young', state: 'idle', src: 'sp05-young-idle.png', scale: 0.9, offsetY: 0.0476, alt: '絨絨獺：杏色圓耳、綠色胸絨與寬尾巴，親切微笑' },
    { species: 'sp05', stage: 'young', state: 'happy', src: 'sp05-young-happy.png', scale: 0.9, offsetY: 0.049, alt: '絨絨獺開心地瞇眼笑，張開雙手歡迎夥伴' },
    { species: 'sp05', stage: 'young', state: '*', src: 'sp05-young-idle.png', scale: 0.9, offsetY: 0.0476, alt: '絨絨獺：杏色圓耳、綠色胸絨與寬尾巴，親切微笑' },
  ],
};
