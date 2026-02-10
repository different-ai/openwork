package com.winning.spark.config

case class AppConfig(
  spark: SparkConfig,
  datasource: DatasourceConfig,
  processor: ProcessorConfig,
  output: OutputConfig
)

case class SparkConfig(
  appName: String = "WiNEX-Spark-Processor",
  master: String = "local[*]",
  parallelism: Int = 100
)

case class DatasourceConfig(
  `type`: String,
  path: String,
  options: Map[String, String] = Map.empty
)

case class ProcessorConfig(
  validation: ValidationConfig = ValidationConfig(),
  cleaning: CleaningConfig = CleaningConfig(),
  transformation: List[TransformRule] = Nil
)

case class ValidationConfig(
  enabled: Boolean = true,
  rules: List[ValidationRule] = Nil
)

case class CleaningConfig(
  enabled: Boolean = true,
  trimWhitespace: Boolean = true,
  removeDuplicates: Boolean = true
)

case class ValidationRule(
  field: String,
  required: Boolean = false,
  pattern: Option[String] = None,
  min: Option[Double] = None,
  max: Option[Double] = None
)

case class TransformRule(
  `type`: String,
  name: String,
  value: String
)

case class OutputConfig(
  `type`: String = "parquet",
  path: String = "/tmp/output",
  mode: String = "overwrite",
  partitionBy: List[String] = Nil
)
