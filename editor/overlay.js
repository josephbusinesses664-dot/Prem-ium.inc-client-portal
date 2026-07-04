(function () {
  'use strict';

  const slug = document.querySelector('meta[name="oc-slug"]')?.content;
  const token = document.querySelector('meta[name="oc-token"]')?.content;
  const business = document.querySelector('meta[name="oc-business"]')?.content || 'your site';
  if (!slug || !token) return;

  // ── Toolbar ──────────────────────────────────────────────────────────────────

  const toolbar = Object.assign(document.createElement('div'), {
    id: 'oc-toolbar',
    innerHTML: `
      <span style="font-weight:700;letter-spacing:.5px;color:#b0563d">Edit My Site</span>
      <span style="display:inline-flex;background:#0a120e;border:1px solid #e7e2d8;border-radius:8px;padding:2px;gap:2px">
        <span style="background:#b0563d;color:#fff;border-radius:6px;padding:4px 12px;font-size:12px;font-weight:600">Content</span>
        <a href="/customize" style="color:#b0563d;text-decoration:none;border-radius:6px;padding:4px 12px;font-size:12px;font-weight:600">Animations &amp; Effects</a>
      </span>
      <span style="opacity:.6;font-size:12px">Click any highlighted element to edit its text or image</span>
      <span id="oc-save-status" style="font-size:12px;color:#3a7a4a"></span>
      <a href="/dashboard" style="margin-left:auto;color:#b4432e;text-decoration:none;font-size:13px">&#10005; Exit</a>
    `,
  });
  Object.assign(toolbar.style, {
    position: 'fixed', top: '0', left: '0', right: '0', zIndex: '2147483647',
    background: '#ffffff', color: '#2b2721', padding: '10px 18px',
    display: 'flex', alignItems: 'center', gap: '16px',
    fontFamily: 'system-ui,sans-serif', fontSize: '13px',
    boxShadow: '0 2px 12px rgba(0,0,0,.6)', borderBottom: '1px solid #e7e2d8',
  });
  document.body.prepend(toolbar);
  document.body.style.paddingTop = '44px';

  // ── Floating edit panel ──────────────────────────────────────────────────────

  const panel = Object.assign(document.createElement('div'), { id: 'oc-panel' });
  Object.assign(panel.style, {
    position: 'fixed', zIndex: '2147483646', display: 'none',
    background: '#ffffff', border: '1px solid #e7e2d8', borderRadius: '10px',
    padding: '16px', width: '320px', boxShadow: '0 8px 32px rgba(0,0,0,.7)',
    fontFamily: 'system-ui,sans-serif', color: '#2b2721', fontSize: '13px',
  });
  panel.innerHTML = `
    <div style="font-weight:600;margin-bottom:10px;color:#b0563d" id="oc-panel-label">Edit element</div>
    <textarea id="oc-input" rows="4" style="width:100%;box-sizing:border-box;background:#faf9f6;color:#2b2721;border:1px solid #e7e2d8;border-radius:6px;padding:8px;font-size:13px;resize:vertical;font-family:inherit"></textarea>
    <div id="oc-img-section" style="display:none;margin-top:8px">
      <label style="font-size:12px;color:#b0563d">Replace image:</label>
      <input type="file" id="oc-file" accept="image/*" style="margin-top:4px;width:100%;color:#2b2721">
    </div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button id="oc-save" style="flex:1;background:#b0563d;color:#fff;border:none;border-radius:6px;padding:8px;cursor:pointer;font-size:13px;font-weight:600">Save Edit</button>
      <button id="oc-request" style="flex:1;background:#f3f1ea;color:#b0563d;border:1px solid #b0563d;border-radius:6px;padding:8px;cursor:pointer;font-size:13px">Request Change</button>
      <button id="oc-cancel" style="background:none;color:#8a8378;border:none;cursor:pointer;font-size:18px;padding:0 4px" title="Cancel">&#x2715;</button>
    </div>
    <div style="border-top:1px solid #e7e2d8;margin-top:12px;padding-top:12px">
      <div style="font-size:11px;color:#8a8378;margin-bottom:8px">Extend this section — reuses the same layout &amp; borders</div>
      <div style="display:flex;gap:8px">
        <button id="oc-duplicate" style="flex:1;background:#f3f1ea;color:#b0563d;border:1px solid #b0563d;border-radius:6px;padding:8px;cursor:pointer;font-size:13px;font-weight:600">Add another like this</button>
        <button id="oc-remove" style="background:none;color:#b4432e;border:1px solid #e3c4bb;border-radius:6px;padding:8px 12px;cursor:pointer;font-size:13px" title="Delete this item"></button>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  let activeEl = null;
  let activeOcId = null;

  // ── Request form ─────────────────────────────────────────────────────────────

  const reqForm = Object.assign(document.createElement('div'), { id: 'oc-req-form' });
  Object.assign(reqForm.style, {
    position: 'fixed', zIndex: '2147483646', display: 'none',
    background: '#ffffff', border: '1px solid #3b5f93', borderRadius: '10px',
    padding: '20px', width: '380px', boxShadow: '0 8px 32px rgba(0,0,0,.7)',
    fontFamily: 'system-ui,sans-serif', color: '#2b2721', fontSize: '13px',
    top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
  });
  reqForm.innerHTML = `
    <div style="font-weight:700;margin-bottom:12px;color:#3b5f93;font-size:15px">Submit Change Request</div>
    <div style="color:#8a8378;font-size:12px;margin-bottom:10px">Describe what you'd like changed. Our team will handle it.</div>
    <textarea id="oc-req-text" rows="5" placeholder="e.g. Add a new service section for AC repair, change the logo to the attached file..." style="width:100%;box-sizing:border-box;background:#faf9f6;color:#2b2721;border:1px solid #3b5f93;border-radius:6px;padding:8px;font-size:13px;resize:vertical;font-family:inherit"></textarea>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button id="oc-req-send" style="flex:1;background:#3b5f93;color:#fff;border:none;border-radius:6px;padding:9px;cursor:pointer;font-size:13px;font-weight:600">Send Request</button>
      <button id="oc-req-cancel" style="background:none;color:#8a8378;border:none;cursor:pointer;font-size:18px">&#x2715;</button>
    </div>
    <div id="oc-req-status" style="margin-top:8px;font-size:12px;color:#3a7a4a"></div>
  `;
  document.body.appendChild(reqForm);

  // ── Highlight editables ──────────────────────────────────────────────────────

  document.querySelectorAll('[data-oc-id]').forEach(el => {
    el.style.cursor = 'pointer';
    el.style.transition = 'outline .15s';
    el.addEventListener('mouseenter', () => {
      el.style.outline = '2px solid #b0563d';
      el.style.outlineOffset = '2px';
    });
    el.addEventListener('mouseleave', () => {
      if (activeEl !== el) { el.style.outline = ''; el.style.outlineOffset = ''; }
    });
    el.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      openPanel(el, e);
    });
  });

  function openPanel(el, e) {
    // Reset previous active
    if (activeEl && activeEl !== el) {
      activeEl.style.outline = '';
      activeEl.style.outlineOffset = '';
    }
    activeEl = el;
    activeOcId = el.getAttribute('data-oc-id');
    el.style.outline = '2px solid #b0563d';

    const isImg = el.tagName.toLowerCase() === 'img';
    document.getElementById('oc-panel-label').textContent = isImg ? 'Replace Image' : `Edit: ${el.tagName.toLowerCase()}`;
    document.getElementById('oc-input').value = isImg ? (el.getAttribute('src') || '') : el.textContent.trim();
    document.getElementById('oc-input').style.display = isImg ? 'none' : 'block';
    document.getElementById('oc-img-section').style.display = isImg ? 'block' : 'none';
    document.getElementById('oc-file').value = '';

    // Position panel near click but keep in viewport
    const px = Math.min(e.clientX, window.innerWidth - 340);
    const py = Math.min(e.clientY + 10, window.innerHeight - 280);
    Object.assign(panel.style, { display: 'block', left: px + 'px', top: py + 'px', right: 'auto', bottom: 'auto' });
  }

  // ── Save edit ────────────────────────────────────────────────────────────────

  document.getElementById('oc-save').addEventListener('click', async () => {
    if (!activeOcId) return;
    const isImg = activeEl?.tagName.toLowerCase() === 'img';
    const saveBtn = document.getElementById('oc-save');
    const status = document.getElementById('oc-save-status');

    let newValue;
    if (isImg) {
      const file = document.getElementById('oc-file').files[0];
      if (!file) { newValue = document.getElementById('oc-input').value.trim(); }
      else {
        newValue = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = e => resolve(e.target.result);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
      }
    } else {
      newValue = document.getElementById('oc-input').value.trim();
    }

    if (!newValue) return;

    saveBtn.textContent = 'Saving…';
    saveBtn.disabled = true;
    status.textContent = '';

    try {
      const r = await fetch(`/api/sites/${slug}/edit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ ocId: activeOcId, newValue, isImage: isImg }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Save failed');

      // Update live in proxy view
      if (isImg) { activeEl.src = newValue.startsWith('data:') ? newValue : newValue; }
      else { activeEl.textContent = newValue; }

      status.textContent = '✓ Saved & deployed!';
      setTimeout(() => { status.textContent = ''; }, 5000);
      closePanel();
    } catch (err) {
      status.style.color = '#b4432e';
      status.textContent = '⚠ ' + err.message;
    } finally {
      saveBtn.textContent = 'Save Edit';
      saveBtn.disabled = false;
    }
  });

  // ── Duplicate / remove section items ──────────────────────────────────────────

  async function sectionAction(kind) {
    if (!activeOcId) return;
    const status = document.getElementById('oc-save-status');
    status.style.color = '#3a7a4a';
    status.textContent = kind === 'duplicate' ? 'Adding…' : 'Removing…';
    try {
      const r = await fetch(`/api/sites/${slug}/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ocId: activeOcId }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Failed');
      status.textContent = kind === 'duplicate' ? '✓ Added — reloading…' : '✓ Removed — reloading…';
      // Reload so the new/removed item gets fresh oc-ids and is editable
      setTimeout(() => location.reload(), 700);
    } catch (err) {
      status.style.color = '#b4432e';
      status.textContent = '⚠ ' + err.message;
    }
  }
  document.getElementById('oc-duplicate').addEventListener('click', () => sectionAction('duplicate'));
  document.getElementById('oc-remove').addEventListener('click', () => {
    if (confirm('Delete this item from your site?')) sectionAction('remove');
  });

  // ── Change request ────────────────────────────────────────────────────────────

  document.getElementById('oc-request').addEventListener('click', () => {
    panel.style.display = 'none';
    const text = document.getElementById('oc-req-text');
    const el = activeEl;
    if (el && el.tagName.toLowerCase() !== 'img') {
      text.value = `Please change "${el.textContent.trim().slice(0, 80)}" to: `;
    } else {
      text.value = '';
    }
    reqForm.style.display = 'block';
    text.focus();
    document.getElementById('oc-req-status').textContent = '';
  });

  document.getElementById('oc-req-send').addEventListener('click', async () => {
    const description = document.getElementById('oc-req-text').value.trim();
    if (!description) return;
    const btn = document.getElementById('oc-req-send');
    btn.textContent = 'Sending…';
    btn.disabled = true;
    try {
      const r = await fetch('/api/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ description }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      document.getElementById('oc-req-status').textContent = '✓ Request submitted!';
      setTimeout(() => { reqForm.style.display = 'none'; }, 2500);
    } catch (err) {
      document.getElementById('oc-req-status').style.color = '#b4432e';
      document.getElementById('oc-req-status').textContent = '⚠ ' + err.message;
    } finally {
      btn.textContent = 'Send Request';
      btn.disabled = false;
    }
  });

  document.getElementById('oc-req-cancel').addEventListener('click', () => { reqForm.style.display = 'none'; });

  // ── Cancel / close panel ─────────────────────────────────────────────────────

  document.getElementById('oc-cancel').addEventListener('click', closePanel);

  function closePanel() {
    panel.style.display = 'none';
    if (activeEl) { activeEl.style.outline = ''; activeEl.style.outlineOffset = ''; }
    activeEl = null;
    activeOcId = null;
  }

  // Close panel on outside click
  document.addEventListener('click', e => {
    if (panel.style.display !== 'none' && !panel.contains(e.target) && !e.target.hasAttribute('data-oc-id')) {
      closePanel();
    }
  }, true);
})();
