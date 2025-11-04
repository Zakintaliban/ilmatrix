/**
 * ILMATRIX Landing Page - Text Effects
 * Features: Split-text character animations, staggered reveals, clip-path effects
 */

(function () {
  'use strict';

  // Check for required libraries
  if (typeof SplitType === 'undefined') {
    console.error('SplitType not loaded');
    return;
  }
  if (typeof gsap === 'undefined') {
    console.error('GSAP not loaded');
    return;
  }

  // Check for reduced motion preference
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function initTextEffects() {
    if (prefersReducedMotion) {
      console.log('Reduced motion - text animations disabled');
      return;
    }

    // ====== HERO HEADLINE SPLIT TEXT ANIMATION ======
    const heroHeadline = document.getElementById('hero-headline');
    if (heroHeadline) {
      // Split text into characters
      const split = new SplitType(heroHeadline, {
        types: 'chars',
        tagName: 'span',
      });

      // Set initial state for characters
      gsap.set(split.chars, {
        opacity: 0,
        y: 50,
        rotationX: -90,
        transformOrigin: '50% 50%',
      });

      // Add CSS for clip-path effect
      const style = document.createElement('style');
      style.textContent = `
        #hero-headline .char {
          display: inline-block;
          clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%);
        }
      `;
      document.head.appendChild(style);

      // Animate characters on page load
      gsap.to(split.chars, {
        opacity: 1,
        y: 0,
        rotationX: 0,
        duration: 1,
        stagger: {
          amount: 0.8,
          from: 'start',
        },
        ease: 'power3.out',
        delay: 0.5,
      });

      // Clip-path reveal
      gsap.fromTo(
        split.chars,
        {
          clipPath: 'polygon(0 -2%, 0 -2%, 0 102%, 0% 102%)',
        },
        {
          clipPath: 'polygon(0 -2%, 100% -2%, 100% 102%, 0 102%)',
          duration: 1.2,
          stagger: {
            amount: 0.8,
            from: 'start',
          },
          ease: 'power2.out',
          delay: 0.5,
        }
      );

      // Text shadow offset effect (inspired by landonorris.com)
      split.chars.forEach((char, index) => {
        char.style.setProperty('--text-offset', '0px');
        gsap.to(char, {
          '--text-offset': '0px',
          duration: 1,
          delay: 0.5 + index * 0.05,
          ease: 'power2.out',
        });
      });
    }

    // ====== SECTION HEADINGS GRADIENT SWEEP ======
    const sectionHeadings = document.querySelectorAll('#features h3, #how h3');
    sectionHeadings.forEach((heading) => {
      // Add gradient background
      heading.style.backgroundImage =
        'linear-gradient(90deg, var(--scene-primary) 0%, var(--scene-secondary) 50%, var(--scene-accent) 100%)';
      heading.style.backgroundSize = '200% auto';
      heading.style.backgroundClip = 'text';
      heading.style.webkitBackgroundClip = 'text';
      heading.style.color = 'transparent';
      heading.style.backgroundPosition = '200% center';

      // Animate gradient sweep
      gsap.to(heading, {
        scrollTrigger: {
          trigger: heading,
          start: 'top 80%',
          toggleActions: 'play none none reverse',
        },
        backgroundPosition: '0% center',
        duration: 1.5,
        ease: 'power2.out',
      });
    });

    // ====== FEATURE CARD TITLES ======
    const featureTitles = document.querySelectorAll('#features h4');
    featureTitles.forEach((title, index) => {
      const split = new SplitType(title, {
        types: 'chars',
        tagName: 'span',
      });

      gsap.from(split.chars, {
        scrollTrigger: {
          trigger: title,
          start: 'top 85%',
          toggleActions: 'play none none reverse',
        },
        opacity: 0,
        y: 20,
        duration: 0.6,
        stagger: 0.03,
        delay: index * 0.1 + 0.2,
        ease: 'power2.out',
      });
    });

    // ====== PARAGRAPH FADE-IN ======
    const paragraphs = document.querySelectorAll('section p');
    paragraphs.forEach((p) => {
      gsap.from(p, {
        scrollTrigger: {
          trigger: p,
          start: 'top 85%',
          toggleActions: 'play none none reverse',
        },
        opacity: 0,
        y: 20,
        duration: 0.8,
        ease: 'power2.out',
      });
    });

    // ====== CTA TEXT SCALE EFFECT ======
    const ctaHeadings = document.querySelectorAll('.rounded-xl h3');
    ctaHeadings.forEach((heading) => {
      gsap.from(heading, {
        scrollTrigger: {
          trigger: heading,
          start: 'top 85%',
          toggleActions: 'play none none reverse',
        },
        opacity: 0,
        scale: 0.8,
        duration: 0.8,
        ease: 'back.out(1.7)',
      });
    });

    console.log('Text effects initialized');
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTextEffects);
  } else {
    // Small delay to ensure other scripts are loaded
    setTimeout(initTextEffects, 100);
  }
})();
