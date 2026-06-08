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
    const isHidden = menu.classList.contains("hidden");

    for (const otherMenu of document.querySelectorAll(".custom-dropdown-menu")) {
      if (otherMenu !== menu) {
        otherMenu.classList.add("hidden");
      }
    }

    if (isHidden) {
      menu.classList.remove("hidden");
    } else {
      menu.classList.add("hidden");
    }
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
