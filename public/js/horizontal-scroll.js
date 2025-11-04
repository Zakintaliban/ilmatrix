/**
 * ILMATRIX Landing Page - Horizontal Scroll Gallery
 * Features: Drag to scroll, progress indicator, scroll snap, smooth animations
 */

(function () {
  'use strict';

  function initHorizontalScroll() {
    const container = document.querySelector('.horizontal-scroll-container');
    const progressBar = document.querySelector('.scroll-progress');

    if (!container || !progressBar) return;

    let isDown = false;
    let startX;
    let scrollLeft;

    // Mouse drag to scroll
    container.addEventListener('mousedown', (e) => {
      isDown = true;
      container.style.cursor = 'grabbing';
      startX = e.pageX - container.offsetLeft;
      scrollLeft = container.scrollLeft;
    });

    container.addEventListener('mouseleave', () => {
      isDown = false;
      container.style.cursor = 'grab';
    });

    container.addEventListener('mouseup', () => {
      isDown = false;
      container.style.cursor = 'grab';
    });

    container.addEventListener('mousemove', (e) => {
      if (!isDown) return;
      e.preventDefault();
      const x = e.pageX - container.offsetLeft;
      const walk = (x - startX) * 2; // Scroll speed multiplier
      container.scrollLeft = scrollLeft - walk;
    });

    // Touch drag support
    let touchStartX = 0;
    let touchScrollLeft = 0;

    container.addEventListener('touchstart', (e) => {
      touchStartX = e.touches[0].pageX - container.offsetLeft;
      touchScrollLeft = container.scrollLeft;
    });

    container.addEventListener('touchmove', (e) => {
      const x = e.touches[0].pageX - container.offsetLeft;
      const walk = (x - touchStartX) * 1.5;
      container.scrollLeft = touchScrollLeft - walk;
    });

    // Update progress bar
    function updateProgress() {
      const scrollWidth = container.scrollWidth - container.clientWidth;
      const scrolled = container.scrollLeft;
      const progress = scrolled / scrollWidth;
      progressBar.style.transform = `scaleX(${Math.max(0, Math.min(1, progress))})`;
    }

    container.addEventListener('scroll', updateProgress);
    updateProgress(); // Initial update

    // Animate items on scroll
    const items = container.querySelectorAll('.horizontal-scroll-item');

    function updateItemsVisibility() {
      const containerRect = container.getBoundingClientRect();

      items.forEach((item) => {
        const itemRect = item.getBoundingClientRect();
        const isVisible =
          itemRect.left < containerRect.right && itemRect.right > containerRect.left;

        const distanceFromCenter = Math.abs(
          (itemRect.left + itemRect.right) / 2 - (containerRect.left + containerRect.right) / 2
        );
        const maxDistance = containerRect.width;
        const scale = Math.max(0.85, 1 - (distanceFromCenter / maxDistance) * 0.15);
        const opacity = Math.max(0.5, 1 - (distanceFromCenter / maxDistance) * 0.5);

        if (isVisible) {
          item.style.transform = `scale(${scale})`;
          item.style.opacity = opacity;
        }
      });
    }

    container.addEventListener('scroll', updateItemsVisibility);
    updateItemsVisibility(); // Initial update

    // Keyboard navigation
    container.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') {
        container.scrollBy({ left: -350, behavior: 'smooth' });
      } else if (e.key === 'ArrowRight') {
        container.scrollBy({ left: 350, behavior: 'smooth' });
      }
    });

    // Make container focusable for keyboard nav
    container.setAttribute('tabindex', '0');

    // Scroll hint animation (only on first visit)
    if (!sessionStorage.getItem('horizontal-scroll-seen')) {
      setTimeout(() => {
        container.scrollBy({ left: 100, behavior: 'smooth' });
        setTimeout(() => {
          container.scrollBy({ left: -100, behavior: 'smooth' });
        }, 600);
      }, 1000);
      sessionStorage.setItem('horizontal-scroll-seen', 'true');
    }

    console.log('Horizontal scroll gallery initialized');
  }

  // Wait for DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initHorizontalScroll);
  } else {
    initHorizontalScroll();
  }
})();
