const header = document.querySelector("[data-header]");
const menuToggle = document.querySelector("[data-menu-toggle]");
const leadForm = document.querySelector("[data-lead-form]");
const formNote = document.querySelector("[data-form-note]");
const lightbox = document.querySelector("[data-lightbox]");
const lightboxImage = document.querySelector("[data-lightbox-image]");
const lightboxCaption = document.querySelector("[data-lightbox-caption]");
const lightboxCounter = document.querySelector("[data-lightbox-counter]");
const lightboxClose = document.querySelector("[data-lightbox-close]");
const lightboxPrev = document.querySelector("[data-lightbox-prev]");
const lightboxNext = document.querySelector("[data-lightbox-next]");
let galleryButtons = [];
let activeGalleryButtons = [];
let activeGalleryIndex = 0;
let previousFocus = null;
let touchStartX = 0;
let touchStartY = 0;

if (menuToggle && header) {
  menuToggle.addEventListener("click", () => {
    const isOpen = header.classList.toggle("menu-open");
    menuToggle.setAttribute("aria-expanded", String(isOpen));
  });

  header.querySelectorAll(".main-nav a").forEach((link) => {
    link.addEventListener("click", () => {
      header.classList.remove("menu-open");
      menuToggle.setAttribute("aria-expanded", "false");
    });
  });
}

if (leadForm && formNote) {
  leadForm.addEventListener("submit", (event) => {
    if (!leadForm.checkValidity()) {
      event.preventDefault();
      formNote.textContent = "Bitte füllen Sie die Pflichtfelder aus.";
      formNote.style.color = "#EE0000";
      leadForm.reportValidity();
      return;
    }

    formNote.textContent = "Vielen Dank. Ihre Anfrage wird jetzt übermittelt.";
    formNote.style.color = "#395746";
  });
}

function initSlider(slider) {
  const slides = Array.from(slider.querySelectorAll(".slide"));
  const prev = slider.querySelector("[data-slider-prev]");
  const next = slider.querySelector("[data-slider-next]");
  const dotsHost = slider.querySelector("[data-slider-dots]");
  const intervalMs = Number(slider.dataset.autoplay || 5600);
  let index = Math.max(0, slides.findIndex((slide) => slide.classList.contains("is-active")));
  let timer = null;

  if (slides.length < 2) return;

  const dots = slides.map((_, dotIndex) => {
    const button = document.createElement("button");
    button.className = "slider-dot";
    button.type = "button";
    button.setAttribute("aria-label", `Bild ${dotIndex + 1} anzeigen`);
    button.addEventListener("click", () => {
      show(dotIndex);
      restart();
    });
    dotsHost?.appendChild(button);
    return button;
  });

  function show(nextIndex) {
    index = (nextIndex + slides.length) % slides.length;
    slides.forEach((slide, slideIndex) => slide.classList.toggle("is-active", slideIndex === index));
    dots.forEach((dot, dotIndex) => dot.classList.toggle("is-active", dotIndex === index));
  }

  function restart() {
    window.clearInterval(timer);
    timer = window.setInterval(() => show(index + 1), intervalMs);
  }

  prev?.addEventListener("click", () => {
    show(index - 1);
    restart();
  });

  next?.addEventListener("click", () => {
    show(index + 1);
    restart();
  });

  slider.addEventListener("mouseenter", () => window.clearInterval(timer));
  slider.addEventListener("mouseleave", restart);

  show(index);
  restart();
}

document.querySelectorAll("[data-slider]").forEach(initSlider);

function refreshGalleryButtons() {
  galleryButtons = Array.from(document.querySelectorAll(".gallery-trigger"));
}

function getGalleryGroup(button) {
  const group = button.closest(".plan-type, .interior-type-grid > article");
  return group ? Array.from(group.querySelectorAll(".gallery-trigger")) : [button];
}

function showGalleryImage(index) {
  if (!activeGalleryButtons.length || !lightboxImage || !lightboxCaption) return;

  activeGalleryIndex = (index + activeGalleryButtons.length) % activeGalleryButtons.length;
  const button = activeGalleryButtons[activeGalleryIndex];
  const image = button.querySelector("img");
  const fullSrc = button.dataset.full || image?.src || "";
  const title = button.dataset.title || image?.alt || "";

  lightboxImage.src = fullSrc;
  lightboxImage.alt = image?.alt || title;
  lightboxCaption.textContent = title;
  if (lightboxCounter) lightboxCounter.textContent = `${activeGalleryIndex + 1} / ${activeGalleryButtons.length}`;
}

function openLightbox(button) {
  if (!lightbox) return;

  previousFocus = document.activeElement;
  activeGalleryButtons = getGalleryGroup(button);
  showGalleryImage(activeGalleryButtons.indexOf(button));
  lightbox.classList.add("is-open");
  lightbox.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  lightboxClose?.focus();
}

function closeLightbox() {
  if (!lightbox) return;

  lightbox.classList.remove("is-open");
  lightbox.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  if (lightboxImage) lightboxImage.src = "";
  activeGalleryButtons = [];
  previousFocus?.focus?.();
}

refreshGalleryButtons();
galleryButtons.forEach((button) => {
  button.addEventListener("click", () => openLightbox(button));
});

lightboxClose?.addEventListener("click", closeLightbox);
lightboxPrev?.addEventListener("click", () => showGalleryImage(activeGalleryIndex - 1));
lightboxNext?.addEventListener("click", () => showGalleryImage(activeGalleryIndex + 1));

lightbox?.addEventListener("click", (event) => {
  if (event.target === lightbox) closeLightbox();
});

lightbox?.addEventListener("touchstart", (event) => {
  const touch = event.changedTouches[0];
  touchStartX = touch.clientX;
  touchStartY = touch.clientY;
}, { passive: true });

lightbox?.addEventListener("touchend", (event) => {
  const touch = event.changedTouches[0];
  const deltaX = touch.clientX - touchStartX;
  const deltaY = touch.clientY - touchStartY;

  if (Math.abs(deltaX) < 50 || Math.abs(deltaX) < Math.abs(deltaY)) return;
  showGalleryImage(activeGalleryIndex + (deltaX < 0 ? 1 : -1));
}, { passive: true });

document.addEventListener("keydown", (event) => {
  if (!lightbox?.classList.contains("is-open")) return;

  if (event.key === "Escape") closeLightbox();
  if (event.key === "ArrowLeft") showGalleryImage(activeGalleryIndex - 1);
  if (event.key === "ArrowRight") showGalleryImage(activeGalleryIndex + 1);
});

const vimeoViewportHost = document.querySelector("[data-vimeo-viewport-player]");
const vimeoViewportFrame = vimeoViewportHost?.querySelector("iframe");

if (vimeoViewportHost && vimeoViewportFrame && window.Vimeo?.Player) {
  const vimeoViewportPlayer = new Vimeo.Player(vimeoViewportFrame);
  let vimeoIsVisible = false;

  const updateVimeoPlayback = () => {
    if (vimeoIsVisible && !document.hidden) {
      vimeoViewportPlayer.setMuted(true).then(() => vimeoViewportPlayer.play()).catch(() => {});
      return;
    }

    vimeoViewportPlayer.pause().catch(() => {});
  };

  const vimeoObserver = new IntersectionObserver((entries) => {
    vimeoIsVisible = entries[0]?.isIntersecting ?? false;
    updateVimeoPlayback();
  }, { threshold: 0.4 });

  vimeoObserver.observe(vimeoViewportHost);
  document.addEventListener("visibilitychange", updateVimeoPlayback);
}
