export function setupDropdown(
  triggerId: string,
  menuId: string,
  onSelect: (value: string, item: HTMLElement) => void,
) {
  const trigger = document.getElementById(triggerId);
  const menu = document.getElementById(menuId);
  if (!trigger || !menu) return;

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.classList.toggle("hidden");
  });

  menu.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest(".dropdown-item") as HTMLElement;
    if (item) {
      const value = item.getAttribute("data-value");
      if (value) {
        onSelect(value, item);
        menu.classList.add("hidden");
      }
    }
  });

  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target as Node) && !trigger.contains(e.target as Node)) {
      menu.classList.add("hidden");
    }
  });
}
