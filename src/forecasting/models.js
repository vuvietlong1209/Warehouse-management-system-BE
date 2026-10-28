const DEFAULT_WMA_WINDOWS = Object.freeze([3, 4, 6, 8]);
const LINEAR_FEATURE_NAMES = Object.freeze([
  'lag_1',
  'lag_2',
  'lag_4',
  'moving_average_4',
  'trend',
]);
const DEFAULT_RIDGE = 1e-8;
const EPSILON = 1e-12;

function normalizeHistory(values, minimumLength = 1) {
  if (!Array.isArray(values) || values.length < minimumLength) {
    throw new Error(`Lịch sử nhu cầu phải có ít nhất ${minimumLength} kỳ`);
  }
  return values.map((value, index) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`Nhu cầu tại vị trí ${index} phải là số hữu hạn không âm`);
    }
    return parsed;
  });
}

function clampForecast(value) {
  if (!Number.isFinite(value)) throw new Error('Kết quả dự báo không phải số hữu hạn');
  return Math.max(0, value);
}

function forecastNaive(values) {
  const history = normalizeHistory(values);
  return history[history.length - 1];
}

function linearWeights(windowSize) {
  return Array.from({ length: windowSize }, (_, index) => index + 1);
}

function forecastWeightedMovingAverage(values, options = {}) {
  const windowSize = Number(options.windowSize);
  if (!Number.isInteger(windowSize) || windowSize <= 0) {
    throw new Error('Cửa sổ WMA phải là số nguyên dương');
  }
  const history = normalizeHistory(values, windowSize);
  const weights = options.weights === undefined
    ? linearWeights(windowSize)
    : options.weights.map(Number);

  if (weights.length !== windowSize) {
    throw new Error('Số trọng số WMA phải bằng kích thước cửa sổ');
  }
  if (weights.some((weight) => !Number.isFinite(weight) || weight < 0)) {
    throw new Error('Trọng số WMA phải là số hữu hạn không âm');
  }
  const weightTotal = weights.reduce((total, weight) => total + weight, 0);
  if (weightTotal <= 0) throw new Error('Tổng trọng số WMA phải lớn hơn 0');

  const window = history.slice(-windowSize);
  const weightedTotal = window.reduce(
    (total, value, index) => total + value * weights[index],
    0,
  );
  return clampForecast(weightedTotal / weightTotal);
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function featureVector(history, targetIndex) {
  if (targetIndex < 4 || history.length < targetIndex) {
    throw new Error('Hồi quy tuyến tính cần ít nhất 4 kỳ trễ để tạo đặc trưng');
  }
  return [
    history[targetIndex - 1],
    history[targetIndex - 2],
    history[targetIndex - 4],
    mean(history.slice(targetIndex - 4, targetIndex)),
    targetIndex,
  ];
}

function buildLinearTrainingData(values) {
  const history = normalizeHistory(values, 10);
  const features = [];
  const targets = [];
  for (let targetIndex = 4; targetIndex < history.length; targetIndex += 1) {
    features.push(featureVector(history, targetIndex));
    targets.push(history[targetIndex]);
  }
  return { history, features, targets };
}

function standardizeFeatures(features) {
  const columnCount = features[0].length;
  const means = [];
  const scales = [];
  for (let column = 0; column < columnCount; column += 1) {
    const values = features.map((row) => row[column]);
    const columnMean = mean(values);
    const variance = mean(values.map((value) => (value - columnMean) ** 2));
    means.push(columnMean);
    scales.push(Math.sqrt(variance) > EPSILON ? Math.sqrt(variance) : 1);
  }
  return {
    means,
    scales,
    rows: features.map((row) => row.map(
      (value, column) => (value - means[column]) / scales[column],
    )),
  };
}

function solveLinearSystem(matrix, vector) {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);

  for (let column = 0; column < size; column += 1) {
    let pivotRow = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivotRow][column])) {
        pivotRow = row;
      }
    }
    if (Math.abs(augmented[pivotRow][column]) < EPSILON) {
      throw new Error('Không thể giải hồi quy tuyến tính do ma trận suy biến');
    }
    [augmented[column], augmented[pivotRow]] = [augmented[pivotRow], augmented[column]];

    const pivot = augmented[column][column];
    for (let index = column; index <= size; index += 1) {
      augmented[column][index] /= pivot;
    }

    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let index = column; index <= size; index += 1) {
        augmented[row][index] -= factor * augmented[column][index];
      }
    }
  }

  return augmented.map((row) => row[size]);
}

function fitLinearRegression(values, options = {}) {
  const ridge = options.ridge === undefined ? DEFAULT_RIDGE : Number(options.ridge);
  if (!Number.isFinite(ridge) || ridge <= 0) {
    throw new Error('Hệ số ổn định số của hồi quy phải lớn hơn 0');
  }

  const { history, features, targets } = buildLinearTrainingData(values);
  const standardized = standardizeFeatures(features);
  const design = standardized.rows.map((row) => [1, ...row]);
  const parameterCount = design[0].length;
  const normalMatrix = Array.from(
    { length: parameterCount },
    () => Array(parameterCount).fill(0),
  );
  const normalVector = Array(parameterCount).fill(0);

  for (let row = 0; row < design.length; row += 1) {
    for (let left = 0; left < parameterCount; left += 1) {
      normalVector[left] += design[row][left] * targets[row];
      for (let right = 0; right < parameterCount; right += 1) {
        normalMatrix[left][right] += design[row][left] * design[row][right];
      }
    }
  }
  for (let index = 1; index < parameterCount; index += 1) {
    normalMatrix[index][index] += ridge;
  }

  return {
    method: 'linear_regression',
    feature_names: [...LINEAR_FEATURE_NAMES],
    coefficients: solveLinearSystem(normalMatrix, normalVector),
    feature_means: standardized.means,
    feature_scales: standardized.scales,
    training_row_count: design.length,
    history_length: history.length,
    ridge,
  };
}

function predictLinearRegression(model, values) {
  const history = normalizeHistory(values, 4);
  if (!model || !Array.isArray(model.coefficients)) {
    throw new Error('Mô hình hồi quy tuyến tính không hợp lệ');
  }
  const rawFeatures = featureVector(history, history.length);
  const standardizedFeatures = rawFeatures.map(
    (value, index) => (value - model.feature_means[index]) / model.feature_scales[index],
  );
  const design = [1, ...standardizedFeatures];
  const prediction = design.reduce(
    (total, value, index) => total + value * model.coefficients[index],
    0,
  );
  return clampForecast(prediction);
}

function forecastLinearRegression(values, options = {}) {
  const history = normalizeHistory(values, 10);
  const model = fitLinearRegression(history, options);
  return predictLinearRegression(model, history);
}

module.exports = {
  DEFAULT_RIDGE,
  DEFAULT_WMA_WINDOWS,
  LINEAR_FEATURE_NAMES,
  buildLinearTrainingData,
  fitLinearRegression,
  forecastLinearRegression,
  forecastNaive,
  forecastWeightedMovingAverage,
  predictLinearRegression,
};

