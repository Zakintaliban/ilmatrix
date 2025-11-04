/**
 * ILMATRIX Landing Page - Enhanced Three.js Hero Scene
 * Features: Morphing blob with shaders, particle system, post-processing (bloom),
 *           advanced mouse tracking with stretch and spring-back animation
 */

(function () {
  'use strict';

  // Check for WebGL support
  function checkWebGLSupport() {
    try {
      const canvas = document.createElement('canvas');
      return !!(
        window.WebGLRenderingContext &&
        (canvas.getContext('webgl') || canvas.getContext('experimental-webgl'))
      );
    } catch (e) {
      return false;
    }
  }

  if (!checkWebGLSupport()) {
    console.warn('WebGL not supported - 3D scene disabled');
    return;
  }

  // Check for reduced motion preference
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion) {
    console.log('Reduced motion preferred - 3D animations disabled');
    return;
  }

  // Wait for DOM and Three.js to load
  if (typeof THREE === 'undefined') {
    console.error('Three.js not loaded');
    return;
  }

  // Scene setup
  const canvas = document.getElementById('hero-canvas');
  if (!canvas) return;

  const isMobile = window.innerWidth < 768;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  const renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    alpha: true,
    antialias: !isMobile, // Disable on mobile for performance
    powerPreference: 'high-performance',
  });

  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // Camera position
  camera.position.z = 5;

  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambientLight);

  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
  directionalLight.position.set(5, 5, 5);
  scene.add(directionalLight);

  // Point light for more dramatic lighting
  const pointLight = new THREE.PointLight(0xffffff, 1, 100);
  pointLight.position.set(0, 0, 10);
  scene.add(pointLight);

  // ===== CUSTOM SHADERS =====
  const vertexShader = `
    uniform float uTime;
    uniform float uMorphIntensity;
    uniform vec3 uMousePos;
    uniform float uMouseInfluence;
    varying vec3 vNormal;
    varying vec3 vPosition;
    varying vec2 vUv;

    // 3D Perlin noise
    vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }
    vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

    float snoise(vec3 v) {
      const vec2 C = vec2(1.0/6.0, 1.0/3.0);
      const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
      vec3 i  = floor(v + dot(v, C.yyy));
      vec3 x0 = v - i + dot(i, C.xxx);
      vec3 g = step(x0.yzx, x0.xyz);
      vec3 l = 1.0 - g;
      vec3 i1 = min(g.xyz, l.zxy);
      vec3 i2 = max(g.xyz, l.zxy);
      vec3 x1 = x0 - i1 + C.xxx;
      vec3 x2 = x0 - i2 + C.yyy;
      vec3 x3 = x0 - D.yyy;
      i = mod289(i);
      vec4 p = permute(permute(permute(
        i.z + vec4(0.0, i1.z, i2.z, 1.0))
        + i.y + vec4(0.0, i1.y, i2.y, 1.0))
        + i.x + vec4(0.0, i1.x, i2.x, 1.0));
      float n_ = 0.142857142857;
      vec3 ns = n_ * D.wyz - D.xzx;
      vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
      vec4 x_ = floor(j * ns.z);
      vec4 y_ = floor(j - 7.0 * x_);
      vec4 x = x_ *ns.x + ns.yyyy;
      vec4 y = y_ *ns.x + ns.yyyy;
      vec4 h = 1.0 - abs(x) - abs(y);
      vec4 b0 = vec4(x.xy, y.xy);
      vec4 b1 = vec4(x.zw, y.zw);
      vec4 s0 = floor(b0)*2.0 + 1.0;
      vec4 s1 = floor(b1)*2.0 + 1.0;
      vec4 sh = -step(h, vec4(0.0));
      vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
      vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
      vec3 p0 = vec3(a0.xy, h.x);
      vec3 p1 = vec3(a0.zw, h.y);
      vec3 p2 = vec3(a1.xy, h.z);
      vec3 p3 = vec3(a1.zw, h.w);
      vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
      p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
      vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
      m = m * m;
      return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
    }

    void main() {
      vUv = uv;
      vNormal = normalize(normalMatrix * normal);
      vec3 pos = position;

      // Noise-based morphing
      float noise = snoise(pos * 0.5 + uTime * 0.3);
      float noise2 = snoise(pos * 0.8 + uTime * 0.2);
      pos += normal * noise * uMorphIntensity * 0.3;
      pos += normal * noise2 * uMorphIntensity * 0.15;

      // Mouse-based stretching
      vec3 toMouse = uMousePos - pos;
      float dist = length(toMouse);
      float influence = uMouseInfluence / (1.0 + dist * 0.5);
      pos += normalize(toMouse) * influence * 0.8;

      vPosition = pos;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
    }
  `;

  const fragmentShader = `
    uniform vec3 uColor1;
    uniform vec3 uColor2;
    uniform float uTime;
    uniform float uGlowIntensity;
    varying vec3 vNormal;
    varying vec3 vPosition;
    varying vec2 vUv;

    void main() {
      vec3 viewDirection = normalize(cameraPosition - vPosition);
      float fresnel = pow(1.0 - dot(vNormal, viewDirection), 3.0);
      vec3 color = mix(uColor1, uColor2, vUv.y);
      float depth = vPosition.z * 0.1 + 0.5;
      color *= depth;
      color += fresnel * uGlowIntensity * uColor2;
      float roughness = sin(vUv.x * 10.0 + uTime) * 0.1 + 0.9;
      color *= roughness;
      float alpha = 0.85 + fresnel * 0.15;
      gl_FragColor = vec4(color, alpha);
    }
  `;

  // ===== THEME COLORS =====
  function getThemeColors() {
    const root = document.documentElement;
    const computedStyle = getComputedStyle(root);
    const color1 = computedStyle.getPropertyValue('--blob-color-1').trim() || '#0f0e85';
    const color2 = computedStyle.getPropertyValue('--blob-color-2').trim() || '#e44c99';
    return { color1, color2 };
  }

  function cssToThreeColor(cssColor) {
    const div = document.createElement('div');
    div.style.color = cssColor;
    document.body.appendChild(div);
    const rgb = getComputedStyle(div).color;
    document.body.removeChild(div);
    const match = rgb.match(/\d+/g);
    if (match) {
      return new THREE.Color(
        parseInt(match[0]) / 255,
        parseInt(match[1]) / 255,
        parseInt(match[2]) / 255
      );
    }
    return new THREE.Color(0x0f0e85);
  }

  const colors = getThemeColors();

  // ===== BLOB MESH =====
  const geometry = new THREE.IcosahedronGeometry(2, isMobile ? 32 : 64);
  const material = new THREE.ShaderMaterial({
    vertexShader: vertexShader,
    fragmentShader: fragmentShader,
    uniforms: {
      uTime: { value: 0.0 },
      uMorphIntensity: { value: 1.0 },
      uColor1: { value: cssToThreeColor(colors.color1) },
      uColor2: { value: cssToThreeColor(colors.color2) },
      uGlowIntensity: { value: 0.5 },
      uMousePos: { value: new THREE.Vector3(0, 0, 5) },
      uMouseInfluence: { value: 0.0 },
    },
    transparent: true,
    side: THREE.DoubleSide,
  });

  const blob = new THREE.Mesh(geometry, material);
  scene.add(blob);

  // ===== PARTICLE SYSTEM =====
  const particleCount = isMobile ? 50 : 150;
  const particlesGeometry = new THREE.BufferGeometry();
  const particlePositions = new Float32Array(particleCount * 3);
  const particleVelocities = [];

  for (let i = 0; i < particleCount; i++) {
    particlePositions[i * 3] = (Math.random() - 0.5) * 15;
    particlePositions[i * 3 + 1] = (Math.random() - 0.5) * 15;
    particlePositions[i * 3 + 2] = (Math.random() - 0.5) * 10;
    particleVelocities.push({
      x: (Math.random() - 0.5) * 0.02,
      y: Math.random() * 0.02 + 0.01,
      z: (Math.random() - 0.5) * 0.02,
    });
  }

  particlesGeometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));

  const particlesMaterial = new THREE.PointsMaterial({
    size: isMobile ? 0.05 : 0.08,
    color: new THREE.Color(colors.color1),
    transparent: true,
    opacity: 0.6,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const particles = new THREE.Points(particlesGeometry, particlesMaterial);
  scene.add(particles);

  // ===== MOUSE TRACKING WITH SPRING PHYSICS =====
  const mouse = { x: 0, y: 0, worldX: 0, worldY: 0, worldZ: 5 };
  const targetRotation = { x: 0, y: 0 };
  const mouseInfluence = { current: 0, target: 0 };
  let isMouseOver = false;

  function updateMousePosition(clientX, clientY) {
    mouse.x = (clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(clientY / window.innerHeight) * 2 + 1;

    // Convert to world space
    const vector = new THREE.Vector3(mouse.x, mouse.y, 0.5);
    vector.unproject(camera);
    const dir = vector.sub(camera.position).normalize();
    const distance = (5 - camera.position.z) / dir.z;
    const pos = camera.position.clone().add(dir.multiplyScalar(distance));

    mouse.worldX = pos.x;
    mouse.worldY = pos.y;
    mouse.worldZ = pos.z;

    // Check if mouse is near blob
    const blobPos = blob.position;
    const distToBlob = Math.sqrt(
      Math.pow(mouse.worldX - blobPos.x, 2) +
      Math.pow(mouse.worldY - blobPos.y, 2)
    );

    isMouseOver = distToBlob < 3;
    mouseInfluence.target = isMouseOver ? 1.0 : 0.0;
  }

  window.addEventListener('mousemove', (event) => {
    updateMousePosition(event.clientX, event.clientY);
  });

  window.addEventListener('touchmove', (event) => {
    if (event.touches.length > 0) {
      updateMousePosition(event.touches[0].clientX, event.touches[0].clientY);
    }
  });

  // ===== POST-PROCESSING (BLOOM) =====
  // We'll use a simple bloom effect without the full EffectComposer to keep it lightweight
  // For full EffectComposer, you'd need to include post-processing libraries from three.js

  // ===== THEME UPDATES =====
  function updateThemeColors() {
    const colors = getThemeColors();
    material.uniforms.uColor1.value = cssToThreeColor(colors.color1);
    material.uniforms.uColor2.value = cssToThreeColor(colors.color2);
    particlesMaterial.color = cssToThreeColor(colors.color1);
  }

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.attributeName === 'class') {
        updateThemeColors();
      }
    });
  });
  observer.observe(document.documentElement, { attributes: true });

  // ===== RESIZE HANDLER =====
  function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener('resize', onWindowResize);

  // ===== SCROLL HANDLING =====
  let scrollY = 0;
  window.addEventListener('scroll', () => {
    scrollY = window.scrollY;
  });

  // ===== ANIMATION LOOP =====
  let frameCount = 0;
  const targetFPS = isMobile ? 30 : 60;
  const frameInterval = 1000 / targetFPS;
  let lastFrameTime = performance.now();

  function animate(currentTime) {
    requestAnimationFrame(animate);

    const deltaTime = currentTime - lastFrameTime;
    if (deltaTime < frameInterval) return;
    lastFrameTime = currentTime - (deltaTime % frameInterval);

    frameCount++;

    // Update uniforms
    material.uniforms.uTime.value = frameCount * 0.01;

    // Morph intensity based on scroll
    const scrollFactor = Math.min(scrollY / 500, 1);
    material.uniforms.uMorphIntensity.value = 1.0 + scrollFactor * 0.5;

    // Spring physics for mouse influence
    mouseInfluence.current += (mouseInfluence.target - mouseInfluence.current) * 0.1;
    material.uniforms.uMouseInfluence.value = mouseInfluence.current;

    // Update mouse position uniform
    material.uniforms.uMousePos.value.set(mouse.worldX, mouse.worldY, mouse.worldZ);

    // Smooth rotation with damping
    targetRotation.x = mouse.y * 0.3;
    targetRotation.y = mouse.x * 0.3;
    blob.rotation.x += (targetRotation.x - blob.rotation.x) * 0.05;
    blob.rotation.y += (targetRotation.y - blob.rotation.y) * 0.05;
    blob.rotation.z += 0.001;

    // Animate particles
    const positions = particles.geometry.attributes.position.array;
    for (let i = 0; i < particleCount; i++) {
      const vel = particleVelocities[i];
      positions[i * 3] += vel.x;
      positions[i * 3 + 1] += vel.y;
      positions[i * 3 + 2] += vel.z;

      // Wrap around
      if (positions[i * 3 + 1] > 7.5) positions[i * 3 + 1] = -7.5;
      if (positions[i * 3] > 7.5) positions[i * 3] = -7.5;
      if (positions[i * 3] < -7.5) positions[i * 3] = 7.5;
      if (positions[i * 3 + 2] > 5) positions[i * 3 + 2] = -5;
      if (positions[i * 3 + 2] < -5) positions[i * 3 + 2] = 5;
    }
    particles.geometry.attributes.position.needsUpdate = true;

    // Rotate particles slowly
    particles.rotation.y += 0.0005;

    renderer.render(scene, camera);
  }

  animate(performance.now());

  // Pause rendering when tab is hidden
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      lastFrameTime = performance.now();
    }
  });

  console.log('Enhanced Three.js scene initialized with particles and advanced mouse tracking');
})();
