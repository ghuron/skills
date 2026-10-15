"""Turn Albert Heijn online-order invoices (PDF) into <order number>.csv files.

Usage: python3 parse_invoice.py [--force] [--out DIR] PDF_OR_DIR...

Reads the given PDFs (or every *.pdf in a given folder) and writes each order's CSV to --out,
or next to its PDF. Orders that already have a CSV are skipped so hand-written notes survive;
--force rewrites them.
Stops on any invoice line it does not recognise, or when the lines don't add up to the invoice total.

pypdf's layout mode keeps the invoice's columns aligned, and the parser relies on that. The iDEAL
payments listed on an invoice can differ from its total: top-ups for items added later, and refunds
for missing items and returned crates, are paid separately.
"""
import csv, glob, os, re, sys
from decimal import Decimal
import pypdf

AMT = r'-?[\d.]*\d,\d\d'
LINE = re.compile(rf'^(?P<indent>\s*)(?P<name>\S.*?)\s+(?:(?P<qty>\d+)\s+)?(?P<vat>\d+%|Geen)\s+(?P<ex>{AMT})\s+(?P<btw>{AMT})\s+(?P<inc>{AMT})$')
SUP = re.compile(rf'^\s+Inclusief SUP heffing ({AMT})$')
TOTAL = re.compile(rf'^\s*Totaal\s+({AMT})\s+({AMT})\s+({AMT})$')
GROUPS = {'Overig', 'Verrekeningen'}
SECTIONS = {'Statiegeld', 'Verpakkingsmateriaal', 'Statiegeld retour', 'Correcties artikelen vorige bestelling(en)'}
FIELDS = ['Item', 'Quantity', 'VAT (%)', 'Total (EUR)', 'Bonus', 'Note']


def dec(s):
    return Decimal(s.replace('.', '').replace(',', '.'))


def parse(path):
    pages = [p.extract_text(extraction_mode='layout') for p in pypdf.PdfReader(path).pages]
    order = re.search(r'Uw bestelling\s*(\d+)', pages[0]).group(1)
    grand = dec(re.search(rf'Totaal inclusief btw\s+({AMT})', pages[0]).group(1))
    paid = sum((dec(a) for a in re.findall(rf'iDEAL \| Wero betaling \[\d\d-\d\d\]\s+({AMT})', '\n'.join(pages))), Decimal(0))

    # page 1 is the VAT summary; the line items (Specificatie) start at the column header on page 2
    lines = '\n'.join(pages[1:]).splitlines()
    start = next(i for i, l in enumerate(lines) if l.strip().startswith('Omschrijving')) + 1
    qty_col = lines[start - 1].index('Aantal')  # quantities are right-aligned under this header
    rows, total = [], None
    pack = None        # Bonus multipack deal name, printed on the line above its product
    extras = False     # past the groceries, in the Overig / Verrekeningen part
    section = None     # heading whose lines are indented under it (Statiegeld, ...)
    wrappable = False  # previous line was a standalone extras line whose name may wrap
    for raw in lines[start:]:
        s = raw.rstrip()
        if not s.strip() or re.match(r'^\s*Pagina \d+ van \d+$', s):
            continue
        m = TOTAL.match(s)
        if m:
            total = dec(m.group(3))
            break
        m = LINE.match(s)
        if m:
            name, qty, bonus = m['name'].strip(), m['qty'] or '', ''
            if qty and m.end('qty') < qty_col:  # a number ending the name, e.g. 'gratis bezorging bij 15'
                name, qty = re.sub(r'\s+', ' ', s[m.start('name'):m.end('qty')]), ''
            if re.search(r'\s+BONUS$', name):
                name, bonus = re.sub(r'\s+BONUS$', '', name), 'Yes'
            if pack is not None and not bonus:
                sys.exit(f'{path}: multipack line {pack!r} not followed by a BONUS item: {s!r}')
            pack = None
            if m['indent']:
                if not section:
                    sys.exit(f'{path}: indented line outside a section: {s!r}')
                name = f'{section}: {name}'
            elif extras:
                section = None
            wrappable = extras and not m['indent']
            rows.append({'Item': name, 'Quantity': qty, 'VAT (%)': m['vat'].rstrip('%').replace('Geen', '0'),
                         'Total (EUR)': dec(m['inc']), 'Bonus': bonus, 'Note': ''})
            continue
        m = SUP.match(s)
        if m and rows:
            rows[-1]['Note'] = f'Includes €{dec(m.group(1))} single-use plastic levy'
            continue
        t = s.strip()
        was_wrappable, wrappable = wrappable, False
        if t in GROUPS:
            extras, section = True, None
        elif extras and t in SECTIONS:
            section = t
        elif was_wrappable:
            rows[-1]['Item'] += ' ' + t
        elif not extras and re.search(r'\d+-?(pack|pk|pck)$|\d+ flessen$', t):
            pack = t
        else:
            sys.exit(f'{path}: unrecognised line: {s!r}')
    if total is None:
        sys.exit(f'{path}: no Totaal line')
    lines_sum = sum(r['Total (EUR)'] for r in rows)
    if not (lines_sum == total == grand):
        sys.exit(f'{path}: lines {lines_sum} / spec total {total} / invoice total {grand} disagree')
    return order, rows, grand, paid


def main():
    args = sys.argv[1:]
    force = '--force' in args
    args = [a for a in args if a != '--force']
    out_dir = None
    if '--out' in args:
        i = args.index('--out')
        out_dir = args[i + 1]
        del args[i:i + 2]
    if not args:
        sys.exit(__doc__)
    pdfs = []
    for a in args:
        pdfs += sorted(glob.glob(os.path.join(a, '*.pdf'))) if os.path.isdir(a) else [a]
    seen = {}
    for path in pdfs:
        order, rows, grand, paid = parse(path)
        if order in seen:
            sys.exit(f'order {order} in both {seen[order]} and {path}')
        seen[order] = path
        out = os.path.join(out_dir or os.path.dirname(path), f'{order}.csv')
        note = '' if paid == grand else f'  (payments on invoice {paid} != total)'
        if os.path.exists(out) and not force:
            print(f'{os.path.basename(path)} -> {order}.csv exists, skipped')
            continue
        with open(out, 'w', encoding='utf-8', newline='') as f:
            w = csv.DictWriter(f, fieldnames=FIELDS, lineterminator='\r\n')
            w.writeheader()
            for r in rows:
                w.writerow({**r, 'Total (EUR)': f"{r['Total (EUR)']:.2f}"})
        print(f'{os.path.basename(path)} -> {order}.csv  {len(rows):3d} lines  {grand:8.2f}{note}')


if __name__ == '__main__':
    main()
