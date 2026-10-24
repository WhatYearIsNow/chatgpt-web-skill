
export const SEL = {
  composerAll:
    'textarea[placeholder="Ask ChatGPT"], div.ProseMirror[contenteditable="true"], [contenteditable="true"]',
  filePhotos: 'input[aria-label="Attach photos"]', // 图片上传（生图参考图）
  fileFiles: 'input[aria-label="Attach files"]', // 通用文件上传（zip；accept=""）
  attachChip: 'button[aria-label^="Remove "]', // 附件已挂上的判据
  send: 'button[aria-label="Send"], button[aria-label*="发送"], button[data-testid="send-button"]',
  userMsg: '[data-chatgpt-search-unit-key$=":user"]',
  assistant: '[data-chatgpt-search-unit-key$=":assistant"]',
  turn: '[data-talvt-turn-state]',
  markdownCopy: '[data-markdown-copy="contents"]',
  profile: 'button[aria-label="Open profile menu"]',
  sidebar: 'button[aria-label="Show sidebar"]',
};

export const RE = {
  root: /^https:\/\/chatgpt\.com\/?(\?.*)?$/, // 新会话根路径（可复用）
  conv: /^https:\/\/chatgpt\.com\/c\//, // 发送后跳转的对话页
  stopBtn: /停止|Stop/,
  genImg: /Generated image/i,
  fail: /used all your free images|Failed to fetch|cloudflare_challenge|Unknown error/,
};
