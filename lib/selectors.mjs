export const SEL = {
  composerAll:
    'textarea[placeholder="Ask ChatGPT"], div.ProseMirror[contenteditable="true"], [contenteditable="true"]',
  filePhotos:
    'input[aria-label="Attach photos"], input[aria-label="附加照片或视频"], input[aria-label="添加照片"]', // 图片上传（生图参考图），兼容中英文 UI
  fileFiles: 'input[aria-label="Attach files"], input[aria-label="附加文件"]', // 通用文件上传（zip；accept=""），兼容中英文 UI
  attachChip: 'button[aria-label^="Remove "], button[aria-label^="移除"]', // 附件已挂上的判据，兼容中英文 UI
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
