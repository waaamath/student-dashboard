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
  version: 'placeholder-1',
  base: document.currentScript ? new URL('.', document.currentScript.src).href : 'pet/',   // src 的基準位置
  stage: { width: 240, height: 240 },
  missing: { src: 'placeholder/missing.svg', scale: 0.8, alt: '尚無素材' },
  species: {   // 種類名稱還沒定案：label 是暫用的
    sp01: { label: '練習獸 A（暫定）' },
    sp02: { label: '練習獸 B（暫定）' },
    sp03: { label: '練習獸 C（暫定）' },
    sp04: { label: '練習獸 D（暫定）' },
    sp05: { label: '練習獸 E（暫定）' },
  },
  items: [
    { species: '*', stage: 'egg', state: '*', src: 'placeholder/egg.svg', scale: 0.78, alt: '練習獸的蛋' },
    { species: 'sp01', stage: 'young', state: '*', src: 'placeholder/sp01-young.svg', alt: '練習獸（暫用圖）' },
    { species: 'sp02', stage: 'young', state: '*', src: 'placeholder/sp02-young.svg', alt: '練習獸（暫用圖）' },
    { species: 'sp03', stage: 'young', state: '*', src: 'placeholder/sp03-young.svg', alt: '練習獸（暫用圖）' },
    { species: 'sp04', stage: 'young', state: '*', src: 'placeholder/sp04-young.svg', alt: '練習獸（暫用圖）' },
    { species: 'sp05', stage: 'young', state: '*', src: 'placeholder/sp05-young.svg', alt: '練習獸（暫用圖）' },
  ],
};
