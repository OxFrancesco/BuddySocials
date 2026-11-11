//! Dithered area charts, drawn into pixels on the CPU: a solid line over a fill
//! that thins out towards the baseline through an ordered (Bayer) pattern, the
//! same look as the phone's charts.

/// Each dither dot is this many device pixels across.
const DOT: usize = 2;

const BAYER: [[u8; 4]; 4] = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

pub struct Series<'a> {
    pub values: &'a [f64],
    pub rgb: [u8; 3],
}

/// Straight-alpha sRGB pixels, `width` by `height`. Later series draw over earlier ones.
pub fn area(width: usize, height: usize, series: &[Series<'_>]) -> Vec<u8> {
    let mut pixels = vec![0u8; width * height * 4];
    if width < 4 || height < 4 {
        return pixels;
    }
    let peak = series.iter().flat_map(|s| s.values.iter().copied()).fold(0.0f64, f64::max);
    let stroke = (DOT as f64 * 1.5).max(2.0);
    for series in series {
        let points = series.values.len();
        if points == 0 {
            continue;
        }
        // Height of the line at every column, leaving room for the stroke at the top.
        let level = |x: usize| -> f64 {
            let value = if points == 1 {
                series.values[0]
            } else {
                let position = x as f64 / (width - 1) as f64 * (points - 1) as f64;
                let left = position.floor() as usize;
                let right = (left + 1).min(points - 1);
                let mix = position - left as f64;
                series.values[left] * (1.0 - mix) + series.values[right] * mix
            };
            let share = if peak > 0.0 { (value / peak).clamp(0.0, 1.0) } else { 0.0 };
            share * (height as f64 - stroke - 1.0)
        };
        for x in 0..width {
            let top = height as f64 - 1.0 - level(x);
            // The stroke thickens where the line is steep so it never breaks.
            let neighbour = height as f64 - 1.0 - level((x + 1).min(width - 1));
            let (from, to) = if neighbour < top { (neighbour, top) } else { (top, neighbour) };
            for y in 0..height {
                let yf = y as f64;
                let on_line = yf >= from - stroke && yf <= to;
                let below = yf > top;
                if !on_line && !below {
                    continue;
                }
                let lit = on_line || {
                    // 55% coverage just under the line, fading to nothing at the baseline.
                    let depth = (yf - top) / (height as f64 - top).max(1.0);
                    let coverage = 0.55 * (1.0 - depth).powf(1.4);
                    let threshold = (BAYER[(y / DOT) % 4][(x / DOT) % 4] as f64 + 0.5) / 16.0;
                    coverage > threshold
                };
                let at = (y * width + x) * 4;
                if lit {
                    pixels[at..at + 3].copy_from_slice(&series.rgb);
                    pixels[at + 3] = 255;
                }
            }
        }
    }
    pixels
}
