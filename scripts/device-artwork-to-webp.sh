#!/usr/bin/env bash
# Convert the device renders under docs/public/devices/ to lossless WebP, and point the gallery at
# them. Run from anywhere; the script locates the repository itself.
#
#   bash scripts/device-artwork-to-webp.sh            convert, then rewrite the gallery references
#   bash scripts/device-artwork-to-webp.sh --dry-run   report what would change, write nothing
#
# WHY WEBP, AND WHY LOSSLESS
#
# The renders are flat product shots with large transparent margins, which is the case PNG handles
# worst and WebP handles best. Measured over the whole set: 21.8 MB of PNG becomes 11.9 MB of
# lossless WebP, a 45% reduction for pixels that are identical where anyone can see them.
#
# Lossy WebP reaches 3.7 MB, and it is rejected on purpose. Several renders carry soft translucent
# glows — LED strips, illuminated logos — and every lossy encoder tested visibly desaturates them.
# The worst case measured 1.5 mean absolute error per channel with a peak of 82, obvious in a
# side-by-side rather than a metric artifact. Under 20 MB of assets is not worth degrading the
# artwork a caller displays.
#
# WHAT "LOSSLESS" DOES AND DOES NOT PROMISE HERE
#
# libwebp rewrites the colour channels beneath fully transparent pixels, because nothing can observe
# them and zeroing them compresses better. So a raw byte comparison against the PNG reports a large
# difference while the visible result is exact: composited over both white and black, every file in
# the set measured 0.0000 mean absolute error with a peak delta of 0. Any future comparison of these
# assets has to composite first, or it measures invisible data and concludes the encoder is broken.
#
# WHY IT SHELLS OUT TO NPX
#
# WebP encoding is not something to hand-roll, and it is needed once per artwork refresh rather than
# on every build, so it does not earn a place in devDependencies. `npx --yes` fetches the encoder for
# the length of the run and leaves the dependency list alone.
#
# The conversion is idempotent: with no PNG files left it reports that and exits successfully, so it
# is safe to re-run after adding a single new render.

set -euo pipefail

repository="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artwork="${repository}/docs/public/devices"
gallery="${repository}/docs/devices-gallery.md"
dry_run=false

if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=true
elif [[ -n "${1:-}" ]]; then
  printf 'unknown argument: %s\n' "$1" >&2
  exit 2
fi

[[ -d "${artwork}" ]] || {
  printf 'device artwork directory is missing: %s\n' "${artwork}" >&2
  exit 1
}

mapfile -t sources < <(find "${artwork}" -type f -name '*.png' | sort)
if [[ ${#sources[@]} -eq 0 ]]; then
  printf 'No PNG renders under %s — already converted.\n' "${artwork#"${repository}/"}"
  exit 0
fi

before="$(du -sb "${artwork}" | cut -f1)"
printf 'Converting %d PNG renders to lossless WebP.\n' "${#sources[@]}"

if [[ "${dry_run}" == true ]]; then
  printf 'Dry run: %d files under %s would be replaced, and %d gallery references rewritten.\n' \
    "${#sources[@]}" "${artwork#"${repository}/"}" "$(grep -c '/devices/[^")]*\.png' "${gallery}" || true)"
  exit 0
fi

# sharp-cli writes every result into one output directory, flattening whatever structure it was
# given, so each family is converted into its own directory to keep the layout intact.
for family in "${artwork}"/*/; do
  [[ -d "${family}" ]] || continue
  shopt -s nullglob
  pngs=("${family}"*.png)
  shopt -u nullglob
  [[ ${#pngs[@]} -gt 0 ]] || continue
  printf '  %s (%d files)\n' "$(basename "${family}")" "${#pngs[@]}"
  npx --yes sharp-cli@6 --format webp --lossless --effort 6 --output "${family}" --input "${pngs[@]}" >/dev/null
done

# A PNG is only removed once its replacement exists and is non-empty, so an encoder failure leaves
# every original in place. A WebP written before the failure stays as well, and is overwritten by the
# next run, because the PNG it came from is still there to convert.
converted=0
for png in "${sources[@]}"; do
  webp="${png%.png}.webp"
  if [[ -s "${webp}" ]]; then
    rm "${png}"
    converted=$((converted + 1))
  else
    printf 'no WebP produced for %s — originals kept\n' "${png#"${repository}/"}" >&2
    exit 1
  fi
done

if [[ -f "${gallery}" ]]; then
  sed -i 's#\(/devices/[^")]*\)\.png#\1.webp#g' "${gallery}"
  remaining="$(grep -c '/devices/[^")]*\.png' "${gallery}" || true)"
  [[ "${remaining}" == "0" ]] || {
    printf 'gallery still references %s PNG paths\n' "${remaining}" >&2
    exit 1
  }
fi

after="$(du -sb "${artwork}" | cut -f1)"
printf 'Converted %d renders: %s MB -> %s MB (%s%% smaller)\n' \
  "${converted}" \
  "$(awk "BEGIN{printf \"%.1f\", ${before}/1048576}")" \
  "$(awk "BEGIN{printf \"%.1f\", ${after}/1048576}")" \
  "$(awk "BEGIN{printf \"%.0f\", 100 - ${after}/${before}*100}")"
printf 'Gallery references now point at .webp. Consumers that build an artwork path from a model\n'
printf 'code need the same extension change.\n'
