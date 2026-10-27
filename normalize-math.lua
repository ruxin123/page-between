-- texmath expects compact array columns; LaTeX itself also accepts spaces.
-- Operate on parsed math only, leaving code examples and the source untouched.
function Math(element)
  -- texmath cannot size vertical arrows or read these circled operators.
  element.text = element.text:gsub("\\textcircled%s*{%s*\\times%s*}", "\\otimes ")
  element.text = element.text:gsub("\\textcircled%s*{%s*%+%s*}", "\\oplus ")
  element.text = element.text:gsub("\\([Bb]igg?[lrm]?)%s*(\\%a+)", function(size, delimiter)
    if delimiter == "\\downarrow" or delimiter == "\\uparrow" or delimiter == "\\updownarrow"
      or delimiter == "\\Downarrow" or delimiter == "\\Uparrow" or delimiter == "\\Updownarrow" then
      return delimiter
    end
  end)
  element.text = element.text:gsub(
    "(\\begin%s*{array}%s*{)([lcr|:%s]+)(})",
    function(before, columns, after)
      return before .. columns:gsub("%s+", "") .. after
    end
  )
  element.text = element.text:gsub("\\tag%s*{([%d%.%'’′]+)}", "\\qquad\\text{(%1)}")
  return element
end
