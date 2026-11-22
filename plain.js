// Turns an answer written with LaTeX maths and Markdown into plain text,
// for copying, typing into a box or reading aloud: $\frac{3}{4}$ → 3/4.

const SYMBOLS = {
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠',
  approx: '≈', equiv: '≡', sim: '~', propto: '∝', infty: '∞', degree: '°', circ: '°', to: '→', rightarrow: '→',
  Rightarrow: '⇒', leftarrow: '←', implies: '⇒', iff: '⇔', in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆',
  cup: '∪', cap: '∩', emptyset: '∅', forall: '∀', exists: '∃', angle: '∠', perp: '⊥', parallel: '∥',
  triangle: '△', therefore: '∴', ldots: '…', cdots: '⋯', dots: '…', prime: '′', partial: '∂', nabla: '∇',
  sum: 'Σ', prod: 'Π', int: '∫', percent: '%',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π',
  rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};

// A single number or letter needs no brackets: \frac{3}{4} → 3/4, \frac{x+1}{2} → (x+1)/2.
const wrap = (s) => (/^(?:\d+(?:\.\d+)?|\p{L})[′°]?$/u.test(s) ? s : `(${s})`);

function texToPlain(tex) {
  let s = tex;
  // Text inside maths, and font changes, keep just their content.
  s = s.replace(/\\(?:text|textbf|textit|mathrm|mathbf|mathit|mathsf|operatorname|boxed|displaystyle)\s*\{([^{}]*)\}/g, '$1');
  // Work from the innermost braces outwards.
  for (let guard = 0; guard < 20; guard++) {
    const before = s;
    s = s
      .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_, a, b) => `${wrap(a.trim())}/${wrap(b.trim())}`)
      .replace(/\\sqrt\s*\[([^\]]*)\]\s*\{([^{}]*)\}/g, (_, n, x) => `${n.trim()}√${wrap(x.trim())}`)
      .replace(/\\sqrt\s*\{([^{}]*)\}/g, (_, x) => `√${wrap(x.trim())}`)
      .replace(/\^\s*\{([^{}]*)\}/g, (_, x) => `^${wrap(x.trim())}`)
      .replace(/_\s*\{([^{}]*)\}/g, (_, x) => `_${wrap(x.trim())}`)
      .replace(/\\(?:text|mathrm|mathbf|boxed|overline|vec|hat|bar)\s*\{([^{}]*)\}/g, '$1');
    if (s === before) break;
  }
  s = s
    .replace(/\^\s*\\circ/g, '°')
    .replace(/\\left|\\right|\\big|\\Big|\\bigg|\\Bigg/g, '')
    .replace(/\\[,;:! ]/g, ' ')
    .replace(/\\quad|\\qquad/g, ' ')
    .replace(/\\%/g, '%')
    .replace(/\\\{/g, '{')
    .replace(/\\\}/g, '}')
    .replace(/\\([A-Za-z]+)/g, (whole, name) => (name in SYMBOLS ? SYMBOLS[name] : name))
    .replace(/[{}]/g, '')
    .replace(/\s*([=<>≤≥≠≈±×÷])\s*/g, ' $1 ')
    .replace(/ {2,}/g, ' ');
  return s.trim();
}

function toPlain(text) {
  return String(text || '')
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => texToPlain(tex))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => texToPlain(tex))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => texToPlain(tex))
    // Inline maths, but not prices: "$5 and $10" stays as it is.
    .replace(/\$(?=\S)([^$\n]*?\S)\$(?!\d)/g, (_, tex) => texToPlain(tex))
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

module.exports = { toPlain };
