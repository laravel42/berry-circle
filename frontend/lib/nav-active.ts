/** True when the current route matches a sidebar nav target (exact or nested). */
export function isNavItemActive(pathname: string, href: string): boolean {
   if (pathname === href) return true;
   return href !== '/' && pathname.startsWith(`${href}/`);
}
