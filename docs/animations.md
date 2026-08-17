# Motion System & Animation Specification

## 1. Curve & Duration Specification

| Token | Curve | Duration | Usage Type |
|:---|:---|:---|:---|
| **Expressive fast spatial** | `cubic-bezier(0.42, 1.67, 0.21, 0.90)` | `350ms` | Springy buttons, tactile pops, active toggles |
| **Expressive default spatial** | `cubic-bezier(0.38, 1.21, 0.22, 1.00)` | `500ms` | Hero morphs, FLIP cover animation, lyrics panel |
| **Expressive slow spatial** | `cubic-bezier(0.39, 1.29, 0.35, 0.98)` | `650ms` | Ambient sheens, boot screen fade-up |
| **Expressive fast effects** | `cubic-bezier(0.31, 0.94, 0.34, 1.00)` | `150ms` | Immediate press opacity/color, fast track swap-out |
| **Expressive default effects** | `cubic-bezier(0.34, 0.80, 0.34, 1.00)` | `200ms` | Modal scrims, icon button hover, toast entrance |
| **Expressive slow effects** | `cubic-bezier(0.34, 0.88, 0.34, 1.00)` | `300ms` | Staggered UI fades, toast exits, artwork shadow |
| **Standard fast spatial** | `cubic-bezier(0.27, 1.06, 0.18, 1.00)` | `350ms` | Dismissals, track title slide-out |
| **Standard default spatial** | `cubic-bezier(0.27, 1.06, 0.18, 1.00)` | `500ms` | Playbar surface transitions, boot overlay exit |
| **Standard slow spatial** | `cubic-bezier(0.27, 1.06, 0.18, 1.00)` | `750ms` | Large layout reconfigurations |
| **Standard fast effects** | `cubic-bezier(0.31, 0.94, 0.34, 1.00)` | `150ms` | Track rows, input focus, tags, chips, buttons |
| **Standard default effects** | `cubic-bezier(0.34, 0.80, 0.34, 1.00)` | `200ms` | View section fadeIn, progress bar updates |
| **Standard slow effects** | `cubic-bezier(0.34, 0.88, 0.34, 1.00)` | `300ms` | Tab switches, secondary text transitions |

---

## 2. CSS Motion Tokens (`:root`)

```css
:root {
  /* Combined Motion Tokens (Duration + Curve) */
  --motion-expressive-fast-spatial: 350ms cubic-bezier(0.42, 1.67, 0.21, 0.90);
  --motion-expressive-default-spatial: 500ms cubic-bezier(0.38, 1.21, 0.22, 1.00);
  --motion-expressive-slow-spatial: 650ms cubic-bezier(0.39, 1.29, 0.35, 0.98);
  --motion-expressive-fast-effects: 150ms cubic-bezier(0.31, 0.94, 0.34, 1.00);
  --motion-expressive-default-effects: 200ms cubic-bezier(0.34, 0.80, 0.34, 1.00);
  --motion-expressive-slow-effects: 300ms cubic-bezier(0.34, 0.88, 0.34, 1.00);

  --motion-standard-fast-spatial: 350ms cubic-bezier(0.27, 1.06, 0.18, 1.00);
  --motion-standard-default-spatial: 500ms cubic-bezier(0.27, 1.06, 0.18, 1.00);
  --motion-standard-slow-spatial: 750ms cubic-bezier(0.27, 1.06, 0.18, 1.00);
  --motion-standard-fast-effects: 150ms cubic-bezier(0.31, 0.94, 0.34, 1.00);
  --motion-standard-default-effects: 200ms cubic-bezier(0.34, 0.80, 0.34, 1.00);
  --motion-standard-slow-effects: 300ms cubic-bezier(0.34, 0.88, 0.34, 1.00);
}
```

---

## 3. Action Mapping Summary

| Action / Interaction | Component / Selector | Motion Token | Duration & Curve |
|:---|:---|:---|:---|
| **Navigation item hover/select** | `.nav-item` | `--motion-standard-default-effects` | `200ms` `cubic-bezier(0.34, 0.80, 0.34, 1.00)` |
| **Search button sheen sweep** | `.nav-search::before` | `--motion-expressive-slow-spatial` | `650ms` `cubic-bezier(0.39, 1.29, 0.35, 0.98)` |
| **Search ping pulse** | `.nav-search.is-pinging` | `--motion-standard-fast-effects` (color), `--motion-expressive-slow-spatial` (scale) | `150ms` / `650ms` |
| **Track row hover** | `.trow` | `--motion-standard-fast-effects` | `150ms` `cubic-bezier(0.31, 0.94, 0.34, 1.00)` |
| **View section change** | `.view-section.active` | `--motion-standard-default-effects` | `200ms` `cubic-bezier(0.34, 0.80, 0.34, 1.00)` |
| **Playbar background shift** | `.playbar` | `--motion-standard-default-spatial` | `500ms` `cubic-bezier(0.27, 1.06, 0.18, 1.00)` |
| **Play/Pause button squish press** | `.button-group .icon-btn` (`applyGroupSquish`) | `--motion-expressive-fast-spatial` | `150ms` `cubic-bezier(0.42, 1.67, 0.21, 0.90)` |
| **Play/Pause button release** | `.button-group .icon-btn` (`releaseGroupSquish`) | `--motion-expressive-fast-spatial` | `350ms` `cubic-bezier(0.42, 1.67, 0.21, 0.90)` |
| **Favorite heart bounce** | `.song-actions .icon-btn.is-animating` (`fav-pop`) | `--motion-expressive-fast-spatial` | `350ms` `cubic-bezier(0.42, 1.67, 0.21, 0.90)` |
| **Mini-artwork hover/fullscreen icon** | `.artwork`, `.artwork .fs-icon` | `--motion-expressive-fast-spatial` (scale), `--motion-expressive-default-effects` (opacity) | `350ms` / `200ms` |
| **Progress time label hover** | `.time-label` | `--motion-expressive-default-effects` | `200ms` `cubic-bezier(0.34, 0.80, 0.34, 1.00)` |
| **Volume thumb hover/drag** | `.volume-slider::-webkit-slider-thumb` | `--motion-expressive-fast-spatial` | `350ms` `cubic-bezier(0.42, 1.67, 0.21, 0.90)` |
| **Track Cover Swap (JS)** | `animateSwap` (`kind: 'cover'`) | Out: `--motion-standard-fast-spatial` (`350ms`), In: `--motion-expressive-default-spatial` (`500ms`) | `350ms` / `500ms` |
| **Track Title Next Swap (JS)** | `animateSwap` (`direction > 0`) | Out: `--motion-standard-fast-spatial` (`350ms`), In: `--motion-expressive-fast-spatial` (`350ms`) | `350ms` / `350ms` |
| **Track Title Prev Swap (JS)** | `animateSwap` (`direction < 0`) | Out: `--motion-expressive-fast-effects` (`150ms`), In: `--motion-expressive-fast-spatial` (`350ms`) | `150ms` / `350ms` |
| **Track Title Fade Swap (JS)** | `animateSwap` (`direction === 0`) | Out: `--motion-expressive-default-effects` (`200ms`), In: `--motion-expressive-slow-effects` (`300ms`) | `200ms` / `300ms` |
| **Fullscreen Cover Morph (FLIP)** | `flipCover` (`big.animate`) | Enter: `--motion-expressive-default-spatial` (`500ms`), Exit: `--motion-expressive-fast-spatial` (`350ms`) | `500ms` / `350ms` |
| **Fullscreen Aura/Canvas reveal** | `.fs-canvas`, `.fs-backdrop` | `--motion-expressive-default-spatial` | `500ms` `cubic-bezier(0.38, 1.21, 0.22, 1.00)` |
| **Fullscreen info staggered enter** | `.fs-overlay .fs-title...` | `--motion-expressive-slow-effects` (opacity), `--motion-expressive-default-spatial` (transform) | `300ms` / `500ms` |
| **Fullscreen lyrics panel open** | `.fs-lyrics-panel` (`lyricsSpringIn`) | `--motion-expressive-default-spatial` | `500ms` `cubic-bezier(0.38, 1.21, 0.22, 1.00)` |
| **Lyrics active line scale** | `.fs-lyrics-line` | `--motion-expressive-fast-spatial` (scale/opacity), `--motion-expressive-slow-effects` (color) | `350ms` / `300ms` |
| **Lyrics word-sync highlight** | `.fs-lyrics-word` | `--motion-expressive-default-effects` | `200ms` `cubic-bezier(0.34, 0.80, 0.34, 1.00)` |
| **Modal scrim enter** | `.modal-overlay.active` | `--motion-expressive-default-effects` | `200ms` `cubic-bezier(0.34, 0.80, 0.34, 1.00)` |
| **Modal / Editor card enter** | `.modal-card`, `.settings-card`, `.editor-card` | `--motion-expressive-fast-spatial` | `350ms` `cubic-bezier(0.42, 1.67, 0.21, 0.90)` |
| **Modal list item stagger** | `#add-to-playlist-modal.active .sl-item` | `--motion-expressive-fast-spatial` | `350ms` `cubic-bezier(0.42, 1.67, 0.21, 0.90)` |
| **Download button pop** | `.btn-dl-anim` (`btn-dl-pop`) | `--motion-expressive-fast-spatial` | `350ms` `cubic-bezier(0.42, 1.67, 0.21, 0.90)` |
| **Download burst particle** | `.dl-particle` | `--motion-expressive-default-spatial` | `500ms` `cubic-bezier(0.38, 1.21, 0.22, 1.00)` |
| **Download progress fill** | `.dl-progress-fill` | `--motion-standard-default-effects` | `200ms` `cubic-bezier(0.34, 0.80, 0.34, 1.00)` |
| **Settings segment & tab click** | `.seg-btn`, `.settings-tab`, `.rep-tab` | `--motion-standard-fast-effects` | `150ms` `cubic-bezier(0.31, 0.94, 0.34, 1.00)` |
| **Switch toggle & steppers** | `.toggle`, `.scale-stepper .stepper-btn` | `--motion-expressive-fast-spatial` | `350ms` `cubic-bezier(0.42, 1.67, 0.21, 0.90)` |
| **Accent color swatch select** | `.accent-swatch` | `--motion-expressive-fast-spatial` | `350ms` `cubic-bezier(0.42, 1.67, 0.21, 0.90)` |
| **Toast entrance** | `.toast` (`toast-in`) | `--motion-expressive-default-effects` | `200ms` `cubic-bezier(0.34, 0.80, 0.34, 1.00)` |
| **Toast exit** | `.toast.leaving` (`toast-out`) | `--motion-expressive-slow-effects` | `300ms` `cubic-bezier(0.34, 0.88, 0.34, 1.00)` |
| **Boot screen fade-up** | `.boot-wrap` (`bootFadeUp`) | `--motion-expressive-slow-spatial` | `650ms` `cubic-bezier(0.39, 1.29, 0.35, 0.98)` |
| **Boot screen dismiss** | `#boot-overlay` | `--motion-standard-default-spatial` | `500ms` `cubic-bezier(0.27, 1.06, 0.18, 1.00)` |

