export function calendarColumnWindow(total: number, width: number, scrollLeft: number) {
  const count = Math.max(1, total);
  const viewportWidth = Math.max(1, width);
  const columnWidth = count * 340 <= viewportWidth ? viewportWidth / count : Math.min(340, viewportWidth);
  const first = Math.min(count - 1, Math.max(0, Math.floor(scrollLeft / columnWidth) - 1));
  const end = Math.min(count, first + Math.ceil(viewportWidth / columnWidth) + 2);
  return { first, end, columnWidth, totalWidth: count * columnWidth };
}
