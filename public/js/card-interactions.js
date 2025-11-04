/**
 * ILMATRIX Landing Page - 3D Card Interactions
 * Features: 3D tilt effects on hover, glow tracking, spring physics
 */

(function () {
  'use strict';

  // Check for reduced motion
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion) return;

  // Initialize 3D tilt effect on feature cards
  function init3DTilt() {
    const cards = document.querySelectorAll('#features .rounded-lg');

    cards.forEach((card) => {
      let bounds;
      const glowLayer = document.createElement('div');
      glowLayer.style.cssText = `
        position: absolute;
        inset: 0;
        border-radius: inherit;
        background: radial-gradient(circle at 50% 50%, var(--glow-color), transparent 70%);
        opacity: 0;
        transition: opacity 0.3s ease;
        pointer-events: none;
        z-index: 1;
      `;
      card.style.position = 'relative';
      card.style.transformStyle = 'preserve-3d';
      card.style.transition = 'transform 0.3s cubic-bezier(0.65, 0.05, 0, 1)';
      card.insertBefore(glowLayer, card.firstChild);

      // Make content relative to keep it above glow
      const content = Array.from(card.children).filter(el => el !== glowLayer);
      content.forEach(el => {
        if (!el.style.position) el.style.position = 'relative';
        if (!el.style.zIndex) el.style.zIndex = '2';
      });

      card.addEventListener('mouseenter', function() {
        bounds = card.getBoundingClientRect();
        glowLayer.style.opacity = '1';
      });

      card.addEventListener('mousemove', function(e) {
        if (!bounds) return;

        const mouseX = e.clientX;
        const mouseY = e.clientY;
        const leftX = mouseX - bounds.left;
        const topY = mouseY - bounds.top;
        const centerX = leftX - bounds.width / 2;
        const centerY = topY - bounds.height / 2;
        const percentX = centerX / (bounds.width / 2);
        const percentY = centerY / (bounds.height / 2);

        // 3D tilt effect
        const maxTilt = 10; // degrees
        const tiltX = -percentY * maxTilt;
        const tiltY = percentX * maxTilt;

        card.style.transform = `
          perspective(1000px)
          rotateX(${tiltX}deg)
          rotateY(${tiltY}deg)
          scale3d(1.05, 1.05, 1.05)
          translateZ(10px)
        `;

        // Update glow position
        const glowX = (leftX / bounds.width) * 100;
        const glowY = (topY / bounds.height) * 100;
        glowLayer.style.background = `radial-gradient(circle at ${glowX}% ${glowY}%, var(--glow-color), transparent 70%)`;
      });

      card.addEventListener('mouseleave', function() {
        card.style.transform = 'perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1) translateZ(0px)';
        glowLayer.style.opacity = '0';
        bounds = null;
      });

      // Touch support (simplified for mobile)
      card.addEventListener('touchstart', function(e) {
        card.style.transform = 'perspective(1000px) scale3d(1.03, 1.03, 1.03)';
        glowLayer.style.opacity = '1';
      });

      card.addEventListener('touchend', function() {
        card.style.transform = 'perspective(1000px) scale3d(1, 1, 1)';
        glowLayer.style.opacity = '0';
      });
    });

    console.log('3D card interactions initialized');
  }

  // Wait for DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init3DTilt);
  } else {
    init3DTilt();
  }
})();
