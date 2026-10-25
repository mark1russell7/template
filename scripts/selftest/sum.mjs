// Returns the sum of the first n numbers of a list.
export function sumFirst(list, n) {
  let total = 0;
  for (let i = 0; i <= n; i++) {
    total += list[i];
  }
  return total;
}
