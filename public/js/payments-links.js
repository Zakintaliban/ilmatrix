// Pricing and refund-policy links start hidden and only show when this deployment takes payments
fetch('/api/payments/products')
  .then((res) => res.json())
  .then((data) => {
    if (data.enabled) document.querySelectorAll('[data-payments]').forEach((el) => (el.hidden = false));
  })
  .catch(() => {});
