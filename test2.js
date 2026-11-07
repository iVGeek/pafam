var r = /^precio/i;
console.log('test PRICE:', r.test('PRICE'));
console.log('test price:', r.test('price'));
console.log('test PRICE.trim():', r.test('PRICE'.trim()));