export const UI = {
  $(selector) {
    return document.querySelector(selector);
  },
  $$(selector) {
    return document.querySelectorAll(selector);
  },
  toast(message, type = 'info', ms = 5000) {
    const box = document.createElement('div');
    box.className = 'toast ' + type;
    const icon = document.createElement('span');
    icon.textContent = { info: 'ℹ️', ok: '✅', err: '⚠️', warn: '🔔' }[type] || 'ℹ️';
    const text = document.createElement('div');
    text.textContent = String(message);
    box.append(icon, text);
    this.$('#toasts').append(box);
    setTimeout(() => box.remove(), ms);
  },
  // body is trusted application markup only; all user values must be escaped.
  modal(title, body, actions) {
    if (this.closeModal) this.closeModal(undefined);
    return new Promise((resolve) => {
      const previousFocus = document.activeElement;
      const box = this.$('#mb'),
        overlay = this.$('#ov');
      box.innerHTML =
        '<h2 id="modalTitle"></h2><div class="modalBody"></div><div class="macts"></div>';
      box.querySelector('h2').textContent = title;
      box.querySelector('.modalBody').innerHTML = body;
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-labelledby', 'modalTitle');
      const close = (value) => {
        overlay.classList.add('hide');
        document.removeEventListener('keydown', keydown);
        this.closeModal = null;
        previousFocus?.focus();
        resolve(value);
      };
      this.closeModal = close;
      for (const action of actions) {
        const button = document.createElement('button');
        button.className = 'btn ' + (action.c || '');
        button.textContent = action.t;
        button.onclick = async () => {
          button.disabled = true;
          try {
            if (action.fn && (await action.fn()) === false) return;
            close(action.v);
          } catch (error) {
            this.toast(error.message, 'err');
          } finally {
            button.disabled = false;
          }
        };
        box.querySelector('.macts').append(button);
      }
      function keydown(event) {
        if (event.key === 'Escape') {
          event.preventDefault();
          close(undefined);
        }
        if (event.key === 'Tab') {
          const elements = [
            ...box.querySelectorAll('button:not(:disabled),input,select,a[href],textarea')
          ];
          const first = elements[0],
            last = elements.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }
      document.addEventListener('keydown', keydown);
      overlay.classList.remove('hide');
      box.querySelector('input,button')?.focus();
    });
  },
  ask(title, message, okText = 'ตกลง', okClass = 'go') {
    return this.modal(title, `<p>${this.escapeHtml(message)}</p>`, [
      { t: 'ยกเลิก', v: false },
      { t: okText, c: okClass, v: true }
    ]);
  },
  escapeHtml(value) {
    return String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  },
  formatTime(value) {
    const seconds = Math.floor(Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0);
    const h = Math.floor(seconds / 3600),
      m = Math.floor((seconds % 3600) / 60),
      s = seconds % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return (h ? pad(h) + ':' : '') + pad(m) + ':' + pad(s);
  }
};
