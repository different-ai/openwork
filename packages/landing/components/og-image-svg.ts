const logoPaths = `
  <path fill="#011627" transform="scale(0.723958 0.723958)" d="M670.016 9.80456C700.542 8.39359 721.223 21.2698 746.57 35.5705L792.565 61.3465L847.289 91.9071C861.282 99.6812 879.667 108.971 891.37 119.122C910.759 135.939 922.626 160.834 923.473 186.494C924.114 205.907 923.794 226.341 923.773 245.989L923.73 349.326L923.701 452.801C923.701 491.695 925.84 526.276 916.777 564.412C907.001 605.263 886.973 642.948 858.584 673.909C826.943 708.919 799.772 720.54 759.28 742.808L656.306 799.701L556.464 854.887C526.234 871.401 510.158 884.943 474.89 886.713C445.361 888.851 423.246 874.824 398.753 861.145L348.95 833.283L297.76 804.589C284.087 796.924 267.119 788.262 255.629 778.354C235.171 760.712 222.689 733.072 221.867 706.162C221.224 685.111 221.553 662.351 221.553 641.051L221.576 517.07L221.614 408.776C221.629 379.759 220.064 344.661 226.113 316.826C233.67 282.822 249.679 251.272 272.658 225.092C284.43 211.721 297.948 199.996 312.849 190.232C333.526 176.657 361.689 162.577 384.045 150.508L488.852 93.2977L569.651 48.8522C588.06 38.5972 607.72 27.1256 626.955 18.6589C640.795 12.5669 655.03 10.7158 670.016 9.80456Z" />
  <path fill="#ffffff" transform="scale(0.723958 0.723958)" d="M829.487 135.206C839.064 133.893 851.239 136.27 859.872 140.361C872.035 146.116 881.351 156.549 885.698 169.284C892.339 188.377 889.96 235.005 889.915 256.763L889.722 375.252L889.607 467.527C889.591 488.951 890.29 512.574 887.824 533.687C884.836 557.275 877.921 580.198 867.367 601.505C835.619 666.244 794.376 685.014 734.634 717.66L635.404 772.211L549.448 819.837C531.359 829.896 508.335 844.125 489.262 850.662C457.163 857.628 434.189 843.398 430.792 809.357C428.903 790.424 429.894 770.325 429.902 751.191L429.989 644.028L429.931 504.112C429.924 479.801 428.443 440.879 432.509 418.505C437.748 390.523 449.846 364.277 467.72 342.118C478.981 328.009 492.366 315.735 507.396 305.735C522.026 296.022 545.776 284.138 561.947 275.36L648.741 227.647L752.85 170.462C765.64 163.415 778.534 156.274 791.235 149.076C804.257 141.697 814.291 136.922 829.487 135.206Z" />
  <path fill="#011627" transform="scale(0.723958 0.723958)" d="M752.698 267.949C792.924 267.604 788.579 308.951 788.564 336.845L788.585 395.288L788.609 477.57C788.603 494.548 789.375 516.803 786.777 533.202C783.78 551.695 776.962 569.361 766.76 585.074C758.088 598.597 747.062 610.456 734.205 620.088C724.627 627.261 714.835 632.194 704.389 637.937L666.519 658.795L610.672 689.615C599.016 695.993 580.979 707.112 568.502 709.784L568.034 709.835C559.615 710.678 551.383 709.367 544.8 703.665C532.06 692.631 532.83 674.84 532.78 659.49C532.755 651.94 532.77 644.39 532.773 636.841L532.81 567.068L532.753 492.436C532.737 472.715 531.898 447.901 535.692 428.969C539.526 409.586 548.169 391.476 560.827 376.302C567.674 368.272 575.58 361.208 584.328 355.304C593.645 349.065 605.712 342.738 615.677 337.293L663.439 311.294L705.777 287.916C719.643 280.242 736.788 269.239 752.698 267.949Z" />
  <path fill="#ffffff" transform="scale(0.723958 0.723958)" d="M752.913 438.639L753.463 438.778C754.402 440.415 754.084 513.012 753.537 520.047C753.037 527.281 751.739 534.438 749.667 541.387C744.735 558.163 735.4 573.311 722.632 585.259C710.656 596.329 696.524 603.478 682.332 611.21L648.714 629.521L567.884 673.796L567.231 673.473C566.74 670.541 567.024 663.862 567.033 660.643L567.08 635.07C567.229 603.622 567.218 572.174 567.045 540.727C575.136 535.657 588.415 529.038 597.043 524.399L644.088 498.651L706.909 464.13C722.043 455.693 737.614 446.664 752.913 438.639Z" />
  <path fill="#ffffff" transform="scale(0.723958 0.723958)" d="M748.561 302.532C753.088 302.142 754.018 304.969 754.273 308.994C754.978 320.091 754.665 331.35 754.632 342.482L754.729 398.185C693.808 432.288 632.619 465.911 571.168 499.05L566.544 501.649C566.412 470.288 561.729 429.298 580.961 402.878C592.009 387.702 608.244 380.226 624.28 371.42L664.102 349.529L717.771 319.55C727.609 314.034 738.563 307.565 748.561 302.532Z" />
  <path fill="#ffffff" transform="scale(0.723958 0.723958)" d="M667.193 44.1094C680.449 43.5092 692.49 44.9422 704.362 51.1416C737.072 68.2222 768.804 87.7213 801.453 104.917C775.143 117.607 742.995 136.732 717.098 151.114L582.343 225.05C566.476 233.888 550.541 242.604 534.541 251.197C507.787 265.651 485.812 276.356 462.96 297.099C433.115 324.436 411.878 359.872 401.844 399.08C394.466 427.889 395.661 449.011 395.673 478.449L395.706 538.159L395.686 710.557L395.74 799.307C395.768 801.943 396.645 819.624 396.045 820.843L395.165 820.538L324.394 780.635C284.71 758.335 254.533 747.018 255.521 694.363C255.857 676.496 255.46 656.444 255.473 638.345L255.501 519.039L255.481 406.593C255.475 383.399 254.214 349.449 258.574 327.533C264.527 298.517 277.805 271.506 297.144 249.069C307.058 237.556 318.555 227.507 331.293 219.225C349.031 207.589 375.141 194.437 394.449 183.918L494.962 128.661L589.084 76.9263C604.628 68.3986 620.309 59.3498 636.171 51.4434C645.64 46.7238 656.691 44.9119 667.193 44.1094Z" />
`;

export function getOgImageDataUrl() {
  const svg = `
    <svg width="1200" height="630" viewBox="0 0 1200 630" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="g1" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(180 130) rotate(20) scale(260 220)">
          <stop stop-color="#1e293b" stop-opacity="0.18" />
          <stop offset="1" stop-color="#1e293b" stop-opacity="0" />
        </radialGradient>
        <radialGradient id="g2" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(1010 120) rotate(-8) scale(250 190)">
          <stop stop-color="#334155" stop-opacity="0.14" />
          <stop offset="1" stop-color="#334155" stop-opacity="0" />
        </radialGradient>
        <radialGradient id="g3" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(930 500) rotate(-12) scale(260 210)">
          <stop stop-color="#475569" stop-opacity="0.14" />
          <stop offset="1" stop-color="#475569" stop-opacity="0" />
        </radialGradient>
        <radialGradient id="g4" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(260 520) rotate(10) scale(240 180)">
          <stop stop-color="#1e293b" stop-opacity="0.12" />
          <stop offset="1" stop-color="#1e293b" stop-opacity="0" />
        </radialGradient>
        <linearGradient id="windowBar" x1="0" y1="75" x2="0" y2="115" gradientUnits="userSpaceOnUse">
          <stop stop-color="rgba(255,255,255,0.9)" />
          <stop offset="1" stop-color="rgba(255,255,255,0.6)" />
        </linearGradient>
        <linearGradient id="agent1" x1="0" y1="0" x2="1" y2="1">
          <stop stop-color="#c084fc" />
          <stop offset="1" stop-color="#60a5fa" />
        </linearGradient>
        <linearGradient id="agent2" x1="0" y1="0" x2="1" y2="1">
          <stop stop-color="#fb923c" />
          <stop offset="1" stop-color="#ef4444" />
        </linearGradient>
      </defs>
      <rect width="1200" height="630" fill="#f6f9fc" />
      <rect width="1200" height="630" fill="url(#g1)" style="mix-blend-mode:multiply" opacity="0.45" />
      <rect width="1200" height="630" fill="url(#g2)" style="mix-blend-mode:multiply" opacity="0.45" />
      <rect width="1200" height="630" fill="url(#g3)" style="mix-blend-mode:multiply" opacity="0.45" />
      <rect width="1200" height="630" fill="url(#g4)" style="mix-blend-mode:multiply" opacity="0.45" />

      <g transform="translate(104 140)">
        <g transform="translate(0 0)">
          <svg x="0" y="0" width="48" height="38" viewBox="0 0 834 649">${logoPaths}</svg>
          <text x="62" y="28" fill="#011627" font-family="Inter, Arial, sans-serif" font-size="36" font-weight="600">OpenWork</text>
        </g>

        <text x="0" y="114" fill="#011627" font-family="Inter, Arial, sans-serif" font-size="62" font-weight="500" letter-spacing="-2.2">
          <tspan x="0" dy="0">The team layer for your</tspan>
          <tspan x="0" dy="72">existing </tspan>
          <tspan font-size="74">agent</tspan>
          <tspan font-size="62"> setup.</tspan>
        </text>

        <g transform="translate(0 286)">
          <rect width="205" height="50" rx="25" fill="rgba(255,255,255,0.6)" stroke="rgba(229,231,235,0.6)" />
          <text x="20" y="31" fill="#6b7280" font-family="Inter, Arial, sans-serif" font-size="15" font-weight="500">Backed by</text>
          <rect x="102" y="14" width="22" height="22" rx="5" fill="#ff6600" />
          <text x="109" y="29" fill="#ffffff" font-family="Inter, Arial, sans-serif" font-size="13" font-weight="700">Y</text>
          <text x="134" y="31" fill="#374151" font-family="Inter, Arial, sans-serif" font-size="15" font-weight="600">Combinator</text>
        </g>
      </g>

      <g transform="translate(620 122)">
        <rect x="0" y="48" width="580" height="480" rx="24" fill="rgba(255,255,255,0.8)" stroke="#ffffff" />
        <rect x="0" y="48" width="580" height="480" rx="24" fill="rgba(255,255,255,0.22)" />
        <rect x="0" y="48" width="580" height="480" rx="24" fill="none" filter="drop-shadow(0 20px 60px rgba(0,0,0,0.15))" />
        <rect x="0" y="48" width="580" height="40" rx="24" fill="url(#windowBar)" />
        <rect x="0" y="72" width="580" height="456" rx="0" fill="#ffffff" />
        <line x1="0" y1="88" x2="580" y2="88" stroke="#f3f4f6" />
        <circle cx="24" cy="68" r="6" fill="rgba(255,95,86,0.9)" stroke="rgba(224,68,62,0.2)" />
        <circle cx="42" cy="68" r="6" fill="rgba(255,189,46,0.9)" stroke="rgba(222,161,35,0.2)" />
        <circle cx="60" cy="68" r="6" fill="rgba(39,201,63,0.9)" stroke="rgba(26,171,41,0.2)" />
        <text x="290" y="72" text-anchor="middle" fill="#6b7280" font-family="Inter, Arial, sans-serif" font-size="12" font-weight="500">OpenWork</text>

        <rect x="20" y="108" width="200" height="400" rx="12" fill="#f9fafb" stroke="#f3f4f6" />
        <rect x="32" y="120" width="176" height="60" rx="12" fill="#ffffff" stroke="#f3f4f6" />
        <circle cx="56" cy="150" r="12" fill="url(#agent1)" />
        <text x="76" y="146" fill="#011627" font-family="Inter, Arial, sans-serif" font-size="14" font-weight="500">Digital Twin</text>
        <text x="76" y="164" fill="#6b7280" font-family="Inter, Arial, sans-serif" font-size="12">Extended digital you</text>
        <circle cx="56" cy="210" r="12" fill="url(#agent2)" opacity="0.85" />
        <text x="76" y="206" fill="#011627" fill-opacity="0.7" font-family="Inter, Arial, sans-serif" font-size="14" font-weight="500">Sales Inbound</text>
        <text x="76" y="224" fill="#6b7280" fill-opacity="0.85" font-family="Inter, Arial, sans-serif" font-size="12">Qualifies leads</text>
        <rect x="44" y="260" width="2" height="84" fill="#e5e7eb" />
        <rect x="56" y="258" width="140" height="36" rx="12" fill="rgba(229,231,235,0.5)" />
        <text x="68" y="281" fill="#374151" font-family="Inter, Arial, sans-serif" font-size="13" font-weight="500">Twitter replies...</text>
        <text x="175" y="281" fill="#9ca3af" font-family="Inter, Arial, sans-serif" font-size="13">1s ago</text>
        <text x="68" y="323" fill="#4b5563" font-family="Inter, Arial, sans-serif" font-size="13">Q3 outliers</text>
        <text x="178" y="323" fill="#9ca3af" font-family="Inter, Arial, sans-serif" font-size="13">15m</text>

        <rect x="236" y="108" width="324" height="400" rx="12" fill="#ffffff" stroke="#f3f4f6" />
        <rect x="284" y="132" width="228" height="46" rx="23" fill="rgba(243,244,246,0.8)" />
        <text x="398" y="160" text-anchor="middle" fill="#1f2937" font-family="Inter, Arial, sans-serif" font-size="14">Like all the replies to this tweet and save the users to a CSV.</text>
        <text x="266" y="214" fill="#d1d5db" font-family="Inter, Arial, sans-serif" font-size="12">›</text>
        <text x="280" y="214" fill="#9ca3af" font-family="Inter, Arial, sans-serif" font-size="12">Navigates to tweet URL</text>
        <text x="266" y="238" fill="#d1d5db" font-family="Inter, Arial, sans-serif" font-size="12">›</text>
        <text x="280" y="238" fill="#9ca3af" font-family="Inter, Arial, sans-serif" font-size="12">Extracts bio data to tweet_replies.csv</text>
        <text x="266" y="290" fill="#1f2937" font-family="Inter, Arial, sans-serif" font-size="14" font-weight="500">I liked 42 replies and saved the data to</text>
        <text x="266" y="312" fill="#1f2937" font-family="Inter, Arial, sans-serif" font-size="14" font-weight="500">&quot;tweet_replies.csv&quot; on your desktop.</text>
        <rect x="236" y="440" width="324" height="68" rx="0" fill="#f9fafb" />
        <line x1="236" y1="440" x2="560" y2="440" stroke="#f3f4f6" />
        <text x="252" y="462" fill="#9ca3af" font-family="Inter, Arial, sans-serif" font-size="12">Describe your task</text>
        <rect x="252" y="472" width="292" height="28" rx="12" fill="#ffffff" stroke="#f3f4f6" />
        <text x="264" y="490" fill="#011627" font-family="Inter, Arial, sans-serif" font-size="13">Like Twitter replies and extract users to CSV.</text>
      </g>
    </svg>
  `;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
