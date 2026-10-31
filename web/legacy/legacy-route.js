// Preserve editable-copy links shared before the website had its own homepage.
if (location.hash.startsWith('#doc=')) {
  const workspace = new URL('./app/', location.href);
  workspace.search = location.search;
  workspace.hash = location.hash;
  location.replace(workspace.href);
}
