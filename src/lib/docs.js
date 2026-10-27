const fs = require('fs');
const path = require('path');

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(line) {
  let s = escapeHtml(line);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}

/** Converts our own DOCUMENTATION.md into simple, readable HTML. */
function renderDocumentation() {
  const filePath = path.join(__dirname, '../../DOCUMENTATION.md');
  if (!fs.existsSync(filePath)) return '<p>Documentation file not found.</p>';
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');

  let html = '';
  let inCodeBlock = false;
  let inTable = false;
  let listOpen = false;

  const closeList = () => { if (listOpen) { html += '</ul>'; listOpen = false; } };

  lines.forEach((raw) => {
    const line = raw.replace(/\r$/, '');

    if (line.trim().startsWith('```')) {
      if (!inCodeBlock) { closeList(); html += '<pre class="doc-code">'; inCodeBlock = true; }
      else { html += '</pre>'; inCodeBlock = false; }
      return;
    }
    if (inCodeBlock) { html += escapeHtml(line) + '\n'; return; }

    if (line.trim().startsWith('|')) {
      const cells = line.split('|').map((c) => c.trim()).filter((c, i, arr) => !(i === 0 && c === '') && !(i === arr.length - 1 && c === ''));
      if (cells.every((c) => /^-+$/.test(c))) return; // separator row
      if (!inTable) { closeList(); html += '<table class="doc-table">'; inTable = true; }
      html += '<tr>' + cells.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>';
      return;
    }
    if (inTable && !line.trim().startsWith('|')) { html += '</table>'; inTable = false; }

    if (line.trim() === '---') { closeList(); html += '<hr class="doc-hr">'; return; }
    if (line.startsWith('### ')) { closeList(); html += `<h4>${inline(line.slice(4))}</h4>`; return; }
    if (line.startsWith('## ')) { closeList(); html += `<h3>${inline(line.slice(3))}</h3>`; return; }
    if (line.startsWith('# ')) { closeList(); html += `<h2>${inline(line.slice(2))}</h2>`; return; }
    if (line.startsWith('> ')) { closeList(); html += `<div class="doc-quote">${inline(line.slice(2))}</div>`; return; }
    if (/^\d+\.\s/.test(line.trim()) || /^-\s/.test(line.trim())) {
      if (!listOpen) { html += '<ul>'; listOpen = true; }
      html += `<li>${inline(line.trim().replace(/^(\d+\.|-)\s/, ''))}</li>`;
      return;
    }
    closeList();
    if (line.trim() === '') { html += ''; return; }
    html += `<p>${inline(line)}</p>`;
  });
  closeList();
  if (inTable) html += '</table>';

  return html;
}

module.exports = { renderDocumentation };
