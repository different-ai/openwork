package com.winning.spark

import org.apache.spark.sql.SparkSession
import org.scalatest.{BeforeAndAfterAll, FunSuite}
import com.winning.spark.config.{ConfigLoader, AppConfig}

class SparkJobTest extends FunSuite with BeforeAndAfterAll {
  private var spark: SparkSession = _
  
  override def beforeAll(): Unit = {
    spark = SparkSession.builder()
      .appName("SparkJobTest")
      .master("local[2]")
      .getOrCreate()
  }
  
  override def afterAll(): Unit = {
    if (spark != null) {
      spark.stop()
    }
  }
  
  test("SparkSession should be initialized") {
    assert(spark != null)
    assert(spark.sparkContext.appName == "SparkJobTest")
  }
  
  test("should create DataFrame from sequence") {
    import spark.implicits._
    
    val data = Seq(
      ("P001", "张三", 25),
      ("P002", "李四", 30)
    ).toDF("id", "name", "age")
    
    assert(data.count() == 2)
    assert(data.columns.length == 3)
    assert(data.columns.contains("id"))
    assert(data.columns.contains("name"))
    assert(data.columns.contains("age"))
  }
  
  test("ConfigLoader should load default config when file not found") {
    val config = ConfigLoader.load("nonexistent.yml")
    
    assert(config != null)
    assert(config.spark.appName == "WiNEX-Spark-Processor")
    assert(config.output.`type` == "parquet")
  }
  
  test("SparkSessionManager should create singleton session") {
    import com.winning.spark.config.SparkConfig
    
    val config = SparkConfig(appName = "TestManager", master = "local[1]")
    val session1 = SparkSessionManager.getOrCreate(config)
    val session2 = SparkSessionManager.getOrCreate(config)
    
    // Should be the same instance
    assert(session1.eq(session2))
  }
}
