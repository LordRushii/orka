/** Luhn checksum, used to raise confidence that a digit run is a real card number. */
export function passesLuhnCheck(digits: string): boolean {
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const char = digits[i];
    if (char === undefined) continue;
    let digit = char.charCodeAt(0) - 48;
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return digits.length > 0 && sum % 10 === 0;
}
