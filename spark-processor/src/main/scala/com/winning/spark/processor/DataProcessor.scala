package com.winning.spark.processor

import org.apache.spark.sql.DataFrame
import com.winning.spark.config.ProcessorConfig

trait DataProcessor {
  def process(df: DataFrame, config: ProcessorConfig): DataFrame
}
