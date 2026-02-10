package com.winning.spark.output

import org.apache.spark.sql.DataFrame
import com.winning.spark.config.OutputConfig

trait DataOutput {
  def write(df: DataFrame, config: OutputConfig): Unit
}
