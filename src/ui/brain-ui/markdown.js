function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(text) {
  return escapeHtml(text).replace(/`/g, "&#96;");
}

function safeHref(rawUrl) {
  const url = String(rawUrl ?? "").trim();
  if (!url) return "";
  if (/^(https?:|mailto:)/i.test(url)) return url;
  if (url.startsWith("/") || url.startsWith("#")) return url;
  return "";
}

// 图片 src 白名单：http(s)、data:image、以及站内绝对路径（如内容寻址的 /media/chat/...）。
// 比 safeHref 多放行 data:image、少放行 mailto/#，避免把不可渲染的目标塞进 <img src>。
function safeImageSrc(rawUrl) {
  const url = String(rawUrl ?? "").trim();
  if (!url) return "";
  if (/^https?:/i.test(url)) return url;
  if (/^data:image\//i.test(url)) return url;
  if (url.startsWith("/")) return url;
  return "";
}

function renderInlineMarkdown(text) {
  const codeTokens = [];
  let html = String(text ?? "").replace(/`([^`]+)`/g, (_, code) => {
    const token = `%%CODETOKEN${codeTokens.length}%%`;
    codeTokens.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  html = escapeHtml(html);
  // 图片 ![alt](src) 必须在链接规则之前处理，否则链接规则会先吃掉 [alt](src) 而漏掉前导的 "!"。
  // data:image base64 URL（如同 Telegram 上傳的圖片）不包 <a> 連結，避免瀏覽器阻擋。
  // 普通 URL 照常包連結，可在 新分頁打開。
  html = html.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, src) => {
    const safeUrl = safeImageSrc(src);
    if (!safeUrl) return alt;
    const altAttr = escapeAttr(alt);
    if (/^data:image\//i.test(safeUrl)) {
      return `<img src="${escapeAttr(safeUrl)}" alt="${altAttr}" title="${altAttr}" class="msg-image" loading="lazy">`;
    }
    return `<a href="${escapeAttr(safeUrl)}" target="_blank" rel="noopener noreferrer" class="msg-image-link">` +
      `<img src="${escapeAttr(safeUrl)}" alt="${altAttr}" title="${altAttr}" class="msg-image" loading="lazy"></a>`;
  });
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, href) => {
    const safeUrl = safeHref(href);
    if (!safeUrl) return label;
    return `<a href="${escapeAttr(safeUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  html = html.replace(/(\*\*|__)(.+?)\1/g, "<strong>$2</strong>");
  html = html.replace(/(\*|_)(.+?)\1/g, "<em>$2</em>");

  codeTokens.forEach((token, index) => {
    html = html.replaceAll(`%%CODETOKEN${index}%%`, token);
  });

  return html;
}

export function renderMarkdown(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const parts = [];
  let paragraph = [];
  let listType = null;
  let listItems = [];
  let quoteLines = [];
  let codeFence = null;
  let codeLines = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    const imageOnly = paragraph.every(line => /^!\[[^\]]*]\([^)]+(?:\s+"[^"]*")?\)\s*$/.test(line.trim()));
    const classAttr = imageOnly ? ` class="msg-media-block"` : "";
    const separator = imageOnly ? "" : "<br>";
    parts.push(`<p${classAttr}>${paragraph.map(renderInlineMarkdown).join(separator)}</p>`);
    paragraph = [];
  }

  function flushList() {
    if (!listType || !listItems.length) return;
    const tag = listType === "ol" ? "ol" : "ul";
    parts.push(`<${tag}>${listItems.map(item => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</${tag}>`);
    listType = null;
    listItems = [];
  }

  function flushQuote() {
    if (!quoteLines.length) return;
    parts.push(`<blockquote>${quoteLines.map(line => renderInlineMarkdown(line)).join("<br>")}</blockquote>`);
    quoteLines = [];
  }

  function flushCode() {
    if (codeFence === null) return;
    const langClass = codeFence ? ` class="language-${escapeAttr(codeFence)}"` : "";
    parts.push(`<pre><code${langClass}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    codeFence = null;
    codeLines = [];
  }

  for (const line of lines) {
    const fenceMatch = line.match(/^```([\w-]+)?\s*$/);
    if (fenceMatch) {
      flushParagraph();
      flushList();
      flushQuote();
      if (codeFence !== null) flushCode();
      else codeFence = fenceMatch[1] || "";
      continue;
    }

    if (codeFence !== null) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      flushQuote();
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      flushQuote();
      const level = headingMatch[1].length;
      parts.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
      continue;
    }

    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quoteLines.push(quoteMatch[1]);
      continue;
    }
    flushQuote();

    const ulMatch = line.match(/^[-*+]\s+(.+)$/);
    if (ulMatch) {
      flushParagraph();
      if (listType && listType !== "ul") flushList();
      listType = "ul";
      listItems.push(ulMatch[1]);
      continue;
    }

    const olMatch = line.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      flushParagraph();
      if (listType && listType !== "ol") flushList();
      listType = "ol";
      listItems.push(olMatch[1]);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  flushQuote();
  flushCode();

  return parts.join("");
}

export function createMarkdownBody(text) {
  const body = document.createElement("div");
  body.className = "msg-body";
  body.innerHTML = renderMarkdown(text);
  return body;
}

// 圖片點擊放大（lightbox）- 避免連結跳轉
document.addEventListener('click', (e) => {
  const img = e.target.closest('.msg-image');
  if (!img) return;
  const src = img.src;
  if (!src || src === 'data:,' || src === 'about:blank') return;
  e.preventDefault();
  e.stopPropagation();

  // 移除舊的 lightbox
  const existing = document.getElementById('img-lightbox');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'img-lightbox';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.88);z-index:99999;display:flex;align-items:center;justify-content:center;cursor:pointer;overflow:auto;';

  const imgFull = document.createElement('img');
  imgFull.src = src;
  imgFull.style.cssText = 'max-width:95vw;max-height:95vh;object-fit:contain;border-radius:6px;box-shadow:0 4px 32px rgba(0,0,0,0.5);';

  // 工具列：下載 + 複製（避免依賴右鍵，手機/觸控裝置也能用）
  const toolbar = document.createElement('div');
  toolbar.className = 'img-lightbox-toolbar';
  toolbar.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);display:flex;gap:10px;z-index:100000;';
  const btnBase = 'padding:8px 16px;border-radius:8px;border:1px solid rgba(255,255,255,0.25);background:rgba(0,0,0,0.6);color:#fff;font-size:13px;cursor:pointer;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);transition:background .15s;';
  const downloadBtn = document.createElement('button');
  downloadBtn.textContent = '下載';
  downloadBtn.style.cssText = btnBase;
  downloadBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const a = document.createElement('a');
    a.href = src;
    a.download = src.split('/').pop().split('?')[0] || 'image.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
  const copyBtn = document.createElement('button');
  copyBtn.textContent = '複製';
  copyBtn.style.cssText = btnBase;
  copyBtn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    try {
      // data URL 直接拆出 base64 內容，避免 fetch 在部分環境失敗
      let dataUrl = src;
      if (/^data:image\//i.test(src)) {
        dataUrl = src;
      } else {
        const res = await fetch(src);
        const blob = await res.blob();
        dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(reader.error || new Error('read failed'));
          reader.readAsDataURL(blob);
        });
      }
      if (window.bailongma?.clipboard?.writeImage) {
        const ok = await window.bailongma.clipboard.writeImage(dataUrl);
        if (ok === true) { copyBtn.textContent = '已複製'; setTimeout(() => { copyBtn.textContent = '複製'; }, 1500); return; }
        // IPC 失敗時 fallback 到 ClipboardItem API
      }
      const blob = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(new Blob([reader.result], { type: dataUrl.match(/^data:([^;,]+)/i)[1] || 'image/png' }));
        reader.onerror = () => reject(reader.error || new Error('read failed'));
        reader.readAsArrayBuffer(dataUrl);
      });
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      copyBtn.textContent = '已複製';
      setTimeout(() => { copyBtn.textContent = '複製'; }, 1500);
    } catch {
      copyBtn.textContent = '失敗';
      setTimeout(() => { copyBtn.textContent = '複製'; }, 1500);
    }
  });
  toolbar.appendChild(downloadBtn);
  toolbar.appendChild(copyBtn);
  overlay.appendChild(imgFull);
  overlay.appendChild(toolbar);

  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) overlay.remove(); });
  overlay.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') overlay.remove(); });

  document.body.appendChild(overlay);
  overlay.focus();
});

