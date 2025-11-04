/**
 * ILMATRIX Landing Page - Page Transitions
 * Features: Custom loading animations, circular wipe reveals, smooth page transitions
 */

(function () {
  'use strict';

  // Check for required library
  if (typeof gsap === 'undefined') {
    console.error('GSAP not loaded');
    return;
  }

  // Check for reduced motion preference
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Create transition overlay
  function createTransitionOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'page-transition-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: linear-gradient(135deg, var(--blob-color-1), var(--blob-color-2));
      z-index: 9999;
      pointer-events: none;
      clip-path: circle(0% at 50% 50%);
    `;
    document.body.appendChild(overlay);
    return overlay;
  }

  // Page load animation
  function pageLoadAnimation() {
    if (prefersReducedMotion) return;

    const overlay = createTransitionOverlay();

    // Expand from center then shrink
    const tl = gsap.timeline({
      onComplete: () => {
        overlay.remove();
      },
    });

    tl.to(overlay, {
      clipPath: 'circle(150% at 50% 50%)',
      duration: 0.8,
      ease: 'power2.in',
    }).to(overlay, {
      clipPath: 'circle(0% at 50% 50%)',
      duration: 0.6,
      ease: 'power2.out',
      delay: 0.2,
    });

    // Fade in content
    gsap.from('main', {
      opacity: 0,
      duration: 1,
      delay: 0.8,
      ease: 'power2.out',
    });
  }

  // Page exit animation
  function pageExitAnimation(url, callback) {
    if (prefersReducedMotion) {
      callback();
      return;
    }

    const overlay = document.getElementById('page-transition-overlay') || createTransitionOverlay();

    // Expand to cover screen
    gsap.to(overlay, {
      clipPath: 'circle(150% at 50% 50%)',
      duration: 0.6,
      ease: 'power2.inOut',
      onComplete: callback,
    });

    // Fade out content
    gsap.to('main', {
      opacity: 0,
      duration: 0.4,
      ease: 'power2.in',
    });
  }

  // Preloader animation (minimal)
  function createPreloader() {
    const preloader = document.createElement('div');
    preloader.id = 'preloader';
    preloader.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: var(--bg-primary, #fff);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      transition: opacity 0.5s ease;
    `;

    const logo = document.createElement('div');
    logo.style.cssText = `
      width: 60px;
      height: 60px;
      border: 3px solid var(--scene-primary);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    `;

    const style = document.createElement('style');
    style.textContent = `
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
    `;
    document.head.appendChild(style);

    preloader.appendChild(logo);
    document.body.appendChild(preloader);

    return preloader;
  }

  // Remove preloader when page is loaded
  function removePreloader() {
    const preloader = document.getElementById('preloader');
    if (preloader) {
      gsap.to(preloader, {
        opacity: 0,
        duration: 0.5,
        onComplete: () => {
          preloader.remove();
        },
      });
    }
  }

  // Intercept navigation links
  function interceptLinks() {
    const links = document.querySelectorAll('a[href^="/app"], a[href^="/about"]');
    links.forEach((link) => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const url = link.getAttribute('href');

        // Only trigger zoom effect for app.html navigation
        const isAppDestination = url.includes('/app') || url.includes('app.html');

        if (isAppDestination) {
          pageExitAnimation(url, () => {
            window.location.href = url;
          });
        } else {
          // Simple navigation without zoom effect for other destinations
          window.location.href = url;
        }
      });
    });
  }

  // Initialize
  function init() {
    // Show preloader only on first load
    if (sessionStorage.getItem('ilmatrix-visited') !== 'true') {
      const preloader = createPreloader();
      window.addEventListener('load', () => {
        removePreloader();
        setTimeout(() => {
          pageLoadAnimation();
        }, 500);
        sessionStorage.setItem('ilmatrix-visited', 'true');
      });
    } else {
      // Skip preloader on subsequent visits
      window.addEventListener('load', () => {
        pageLoadAnimation();
      });
    }

    // Intercept navigation
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', interceptLinks);
    } else {
      interceptLinks();
    }

    console.log('Page transitions initialized');
  }

  init();
})();
