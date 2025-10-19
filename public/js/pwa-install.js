// PWA Installation and Service Worker Registration

let deferredPrompt;
let swRegistration = null;

const bodyDataset = document.body ? document.body.dataset : {};
const assetVersion = (bodyDataset && bodyDataset.assetVersion) || window.__ASSET_VERSION__ || 'dev';
const shouldRegisterServiceWorker = (() => {
  if (bodyDataset && typeof bodyDataset.swEnabled !== 'undefined') {
    return bodyDataset.swEnabled !== 'false';
  }
  if (typeof window.__ENABLE_SERVICE_WORKER__ !== 'undefined') {
    return window.__ENABLE_SERVICE_WORKER__ !== false;
  }
  return true;
})();

// Register service worker
if ('serviceWorker' in navigator) {
  if (shouldRegisterServiceWorker) {
    window.addEventListener('load', () => {
      const swUrl = `/service-worker.js?v=${encodeURIComponent(assetVersion)}`;

      navigator.serviceWorker
        .register(swUrl)
        .then((registration) => {
          console.log('Service Worker registered successfully:', registration.scope);
          swRegistration = registration;

          // Check for updates
          registration.addEventListener('updatefound', () => {
            const newWorker = registration.installing;
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                // New service worker available
                if (confirm('New version available! Reload to update?')) {
                  newWorker.postMessage({ type: 'SKIP_WAITING' });
                  window.location.reload();
                }
              }
            });
          });
        })
        .catch((error) => {
          console.error('Service Worker registration failed:', error);
        });

      // Listen for controller change
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        window.location.reload();
      });
    });
  } else {
    // Explicitly unregister existing service workers if disabled
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      registrations.forEach((registration) => registration.unregister());
    });
  }
}

// Capture the install prompt event
window.addEventListener('beforeinstallprompt', (e) => {
  // Prevent the mini-infobar from appearing on mobile
  e.preventDefault();
  // Stash the event so it can be triggered later
  deferredPrompt = e;
  // Show install button if you have one
  showInstallButton();
});

// Show install button (if you want to add one)
function showInstallButton() {
  const installBtn = document.getElementById('install-btn');
  if (installBtn) {
    installBtn.style.display = 'block';
    installBtn.addEventListener('click', installApp);
  }
}

// Install the app
async function installApp() {
  if (!deferredPrompt) {
    return;
  }

  // Show the install prompt
  deferredPrompt.prompt();

  // Wait for the user to respond
  const { outcome } = await deferredPrompt.userChoice;
  console.log(`User response to install prompt: ${outcome}`);

  // Clear the deferred prompt
  deferredPrompt = null;

  // Hide install button
  const installBtn = document.getElementById('install-btn');
  if (installBtn) {
    installBtn.style.display = 'none';
  }
}

// Detect if app is installed
window.addEventListener('appinstalled', () => {
  console.log('PWA was installed');
  deferredPrompt = null;
});

// Check if running as PWA
function isPWA() {
  return window.matchMedia('(display-mode: standalone)').matches ||
         window.navigator.standalone === true;
}

// iOS detection
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

// Show iOS install instructions if needed
if (isIOS() && !isPWA()) {
  console.log('iOS user - show install instructions');
  // You can show a custom modal with iOS install instructions here
}
