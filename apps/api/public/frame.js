// Runs in <head> (CSP allows only same-origin scripts, no inline): flag iframe mode before first paint.
if (window.top !== window.self) document.documentElement.classList.add('framed');
