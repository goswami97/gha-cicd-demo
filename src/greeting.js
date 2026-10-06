export function greet(name) {
  if (!name) {
    throw new Error('name is required');
  }
  return `Hello, ${name}! Deployed via GitHub Actions. This is v1`;
}
