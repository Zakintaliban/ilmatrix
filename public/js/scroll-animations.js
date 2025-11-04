/**
 * ILMATRIX Landing Page - Scroll Animations
 * Features: Lenis smooth scroll, GSAP ScrollTrigger animations, parallax effects
 */

(function () {
  'use strict';

  // Check for required libraries
  if (typeof Lenis === 'undefined') {
    console.error('Lenis not loaded');
    return;
  }
  if (typeof gsap === 'undefined' || typeof ScrollTrigger === 'undefined') {
    console.error('GSAP or ScrollTrigger not loaded');
    return;
  }

  // Check for reduced motion preference
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Initialize Lenis smooth scroll
  const lenis = new Lenis({
    duration: 1.2,
    easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)), // easeOutExpo
    orientation: 'vertical',
    gestureOrientation: 'vertical',
    smoothWheel: !prefersReducedMotion,
    wheelMultiplier: 1,
    smoothTouch: false, // Disable on touch for better mobile performance
    touchMultiplier: 2,
    infinite: false,
  });

  // Sync Lenis with GSAP ScrollTrigger
  lenis.on('scroll', ScrollTrigger.update);

  gsap.ticker.add((time) => {
    lenis.raf(time * 1000);
  });

  gsap.ticker.lagSmoothing(0);

  // Register ScrollTrigger plugin
  gsap.registerPlugin(ScrollTrigger);

  // Wait for DOM to be ready
  function initScrollAnimations() {
    if (prefersReducedMotion) {
      console.log('Reduced motion - scroll animations disabled');
      return;
    }

    // ====== FEATURES SECTION ANIMATIONS ======
    const featureCards = document.querySelectorAll('#features .rounded-lg');
    if (featureCards.length > 0) {
      featureCards.forEach((card, index) => {
        // Staggered fade-in + slide-up
        gsap.from(card, {
          scrollTrigger: {
            trigger: card,
            start: 'top 85%',
            end: 'top 60%',
            toggleActions: 'play none none reverse',
          },
          opacity: 0,
          y: 50,
          duration: 0.8,
          delay: index * 0.1,
          ease: 'power3.out',
        });

        // Clip-path reveal
        gsap.from(card, {
          scrollTrigger: {
            trigger: card,
            start: 'top 85%',
            end: 'top 60%',
            toggleActions: 'play none none reverse',
          },
          clipPath: 'polygon(0 0, 0 0, 0 100%, 0% 100%)',
          duration: 1,
          delay: index * 0.1,
          ease: 'power2.out',
        });

        // Hover scale effect (CSS transform for performance)
        card.style.transition = 'transform 0.3s cubic-bezier(0.65, 0.05, 0, 1)';
        card.addEventListener('mouseenter', () => {
          if (!prefersReducedMotion) {
            card.style.transform = 'scale(1.05)';
          }
        });
        card.addEventListener('mouseleave', () => {
          card.style.transform = 'scale(1)';
        });
      });
    }

    // ====== HOW IT WORKS SECTION ANIMATIONS ======
    const howSteps = document.querySelectorAll('#how .how-step');
    if (howSteps.length > 0) {
      howSteps.forEach((step, index) => {
        gsap.from(step, {
          scrollTrigger: {
            trigger: step,
            start: 'top 80%',
            end: 'top 50%',
            toggleActions: 'play none none reverse',
          },
          opacity: 0,
          x: index % 2 === 0 ? -50 : 50,
          rotation: index % 2 === 0 ? -5 : 5,
          duration: 0.9,
          delay: index * 0.15,
          ease: 'power3.out',
        });
      });
    }

    // ====== HERO SECTION PARALLAX ======
    const heroContent = document.querySelector('main > section:first-child > div');
    if (heroContent) {
      gsap.to(heroContent, {
        scrollTrigger: {
          trigger: heroContent,
          start: 'top top',
          end: 'bottom top',
          scrub: true,
        },
        y: 100,
        opacity: 0.5,
        ease: 'none',
      });
    }

    // ====== CTA SECTION REVEAL ======
    const ctaSection = document.querySelector('main > section:last-of-type');
    if (ctaSection) {
      const ctaBox = ctaSection.querySelector('.rounded-xl');
      if (ctaBox) {
        gsap.from(ctaBox, {
          scrollTrigger: {
            trigger: ctaBox,
            start: 'top 85%',
            end: 'top 60%',
            toggleActions: 'play none none reverse',
          },
          opacity: 0,
          scale: 0.9,
          clipPath: 'polygon(50% 0%, 50% 0%, 50% 100%, 50% 100%)',
          duration: 1,
          ease: 'power3.out',
        });
      }
    }

    // ====== SECTION HEADINGS ANIMATION ======
    const sectionHeadings = document.querySelectorAll('#features h3, #how h3');
    sectionHeadings.forEach((heading) => {
      gsap.from(heading, {
        scrollTrigger: {
          trigger: heading,
          start: 'top 85%',
          end: 'top 65%',
          toggleActions: 'play none none reverse',
        },
        opacity: 0,
        letterSpacing: '0.5em',
        duration: 1,
        ease: 'power2.out',
      });
    });

    // ====== BUTTONS SCALE ANIMATION ======
    const buttons = document.querySelectorAll('a[href="/app"], a[href="/about"]');
    buttons.forEach((button) => {
      gsap.from(button, {
        scrollTrigger: {
          trigger: button,
          start: 'top 90%',
          toggleActions: 'play none none reverse',
        },
        opacity: 0,
        scale: 0.8,
        duration: 0.6,
        ease: 'back.out(1.7)',
      });
    });

    // ====== FEATURE SHOWCASE GRID PARALLAX ======
    const featureBoxes = document.querySelectorAll('.grid .rounded-lg .rounded-md');
    featureBoxes.forEach((box, index) => {
      gsap.to(box, {
        scrollTrigger: {
          trigger: box,
          start: 'top bottom',
          end: 'bottom top',
          scrub: true,
        },
        y: (index % 2 === 0 ? -20 : 20),
        ease: 'none',
      });
    });

    console.log('Scroll animations initialized');
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initScrollAnimations);
  } else {
    initScrollAnimations();
  }

  // Smooth scroll to anchors
  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener('click', (e) => {
      e.preventDefault();
      const target = document.querySelector(anchor.getAttribute('href'));
      if (target) {
        lenis.scrollTo(target, {
          offset: -100,
          duration: 1.5,
        });
      }
    });
  });

  // Expose lenis instance globally for debugging
  window.lenis = lenis;
})();
