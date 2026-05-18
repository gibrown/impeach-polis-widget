# impeach-polis-widget

Public CDN source for the [impeachpolis.org](https://impeachpolis.org) representative lookup widget.

Files in this repo are served via [jsDelivr](https://www.jsdelivr.com/):

- JS: `https://cdn.jsdelivr.net/gh/gibrown/impeach-polis-widget@trunk/rep-lookup.js`
- CSS: `https://cdn.jsdelivr.net/gh/gibrown/impeach-polis-widget@trunk/rep-lookup.css`
- Data: `https://cdn.jsdelivr.net/gh/gibrown/impeach-polis-widget@trunk/reps.json`

## WordPress.com Embed

Add a Custom HTML block to the Make the Call page:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/gibrown/impeach-polis-widget@trunk/rep-lookup.css">
<div id="rep-lookup-widget" data-api-key="YOUR_GOOGLE_API_KEY"></div>
<script src="https://cdn.jsdelivr.net/gh/gibrown/impeach-polis-widget@trunk/rep-lookup.js"></script>
```

## Updating

Data is updated by running `bash scripts/deploy_widget.sh` in the private impeach-polis repo.
=======
Lookup widget for impeachpolis.org. Compiled code only.
